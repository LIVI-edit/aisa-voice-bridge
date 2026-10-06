import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { AriClient, waitForAriEvent } from './ari.js';
import { OpenAILive } from './openai-live.js';
import { parseRtp, RtpPacketizer } from './rtp.js';
import { AudioQueue, AudioPacer } from './audio-queue.js';
import { safeMessage, normalizeZadarmaNumber } from './config.js';

export class CallSession {
  constructor(config, number, dependencies = {}) {
    this.config = config;
    this.number = number;
    this.zadarmaNumber = normalizeZadarmaNumber(number);
    this.app = `aisa-mvp-${randomUUID()}`;
    this.phoneId = `aisa-phone-${randomUUID()}`;
    this.externalId = `aisa-media-${randomUUID()}`;
    this.bridgeId = `aisa-bridge-${randomUUID()}`;
    this.ari = dependencies.ari || new AriClient(config, this.app);
    this.live = dependencies.live || new OpenAILive(config);
    this.udp = dependencies.udp || dgram.createSocket('udp4');
    this.log = dependencies.log || console.log;
    this.warn = dependencies.warn || console.error;
    this.abort = new AbortController();
    this.queue = new AudioQueue(config.maxQueueFrames);
    // ulaw in Asterisk's RTP transport uses static PT=0. The configurable PT
    // is only an input acceptance override, never a codec conversion.
    this.packetizer = new RtpPacketizer({ payloadType: 0 });
    this.pacer = new AudioPacer(this.queue, (frame) => this.sendFrame(frame),
      (error) => this.cleanup('Ошибка отправки RTP', error));
    this.closing = false;
    this.mediaActive = false;
    this.failed = false;
    this.stats = { inputPackets: 0, inputBytes: 0, outputPackets: 0,
      invalidPackets: 0, foreignPackets: 0, stalePackets: 0 };
    this.done = new Promise((resolve) => { this.resolveDone = resolve; });
    this.ari.on('fault', (error) => this.cleanup('Ошибка ARI', error));
    this.live.on('fault', (error) => this.cleanup('Ошибка OpenAI', error));
    this.ari.on('event', (event) => this.handleAriEvent(event));
    this.live.on('audio', (bytes) => {
      // GPT-Live starts before dialing. Never queue/replay pre-answer audio;
      // greeting is requested again only when the media path is ready.
      if (!this.mediaActive || this.closing) return;
      try { this.pacer.push(bytes); }
      catch (error) { this.cleanup('Ошибка очереди аудио', error); }
    });
    this.udp.on('message', (packet, remote) => this.receiveRtp(packet, remote));
    this.udp.on('error', () => this.cleanup('Ошибка UDP', new Error('Локальный RTP/UDP сокет недоступен.')));
  }

  assertActive() { if (this.closing) throw new Error('Запуск отменён: вызов завершён.'); }

  async run() {
    if (this.closing) return this.done;
    if (this.startTask) throw new Error('CallSession допускает только один запуск.');
    this.startTask = this.start();
    try { await this.startTask; }
    catch (error) { if (!this.closing) void this.cleanup('Не удалось запустить звонок', error); }
    return this.done;
  }

  async start() {
    this.log('Подключение к локальному ARI…');
    await this.ari.connect(); this.assertActive();
    this.log('Подключение к GPT-Live…');
    await this.live.connect(); this.assertActive();
    await new Promise((resolve, reject) => {
      const error = () => { this.udp.off('listening', listening); reject(new Error('Не удалось открыть локальный UDP порт.')); };
      const listening = () => { this.udp.off('error', error); this.udpBound = true; resolve(); };
      this.udp.once('error', error); this.udp.once('listening', listening);
      this.udp.bind(0, this.config.bindAddress);
    });
    this.assertActive();
    const phoneReady = waitForAriEvent(this.ari,
      (event) => event.type === 'StasisStart' && event.channel?.id === this.phoneId,
      (this.config.answerTimeoutSeconds + 10) * 1000, this.abort.signal);
    // Attach a rejection observer immediately, even if REST is still pending.
    phoneReady.catch(() => {});
    this.phoneAttempted = true;
    this.log('Исходящий звонок через Zadarma. Ожидание ответа…');
    await this.ari.request('POST', '/channels', {
      endpoint: `PJSIP/${this.zadarmaNumber}@${this.config.endpoint}`,
      app: this.app, channelId: this.phoneId,
      timeout: this.config.answerTimeoutSeconds, formats: 'ulaw',
    });
    this.assertActive();
    const answered = await phoneReady; this.assertActive();
    if (answered.channel?.state !== 'Up') throw new Error('Телефонный канал вошёл в ARI без подтверждённого ответа (Up).');
    this.bridgeAttempted = true;
    // proxy_media prevents native/direct media from bypassing Asterisk.
    await this.ari.request('POST', `/bridges/${this.bridgeId}`, { type: 'mixing,proxy_media' });
    this.assertActive();
    await this.ari.request('POST', `/bridges/${this.bridgeId}/addChannel`, { channel: this.phoneId });
    this.assertActive();
    const mediaReady = waitForAriEvent(this.ari,
      (event) => event.type === 'StasisStart' && event.channel?.id === this.externalId,
      this.config.requestTimeoutMs + 5000, this.abort.signal);
    mediaReady.catch(() => {});
    this.externalAttempted = true;
    await this.ari.request('POST', '/channels/externalMedia', {
      app: this.app, channelId: this.externalId,
      external_host: `${this.config.bindAddress}:${this.udp.address().port}`,
      transport: 'udp', encapsulation: 'rtp', connection_type: 'client',
      format: 'ulaw', direction: 'both',
    });
    this.assertActive();
    await mediaReady; this.assertActive();
    const address = await this.ari.request('GET', `/channels/${this.externalId}/variable`,
      { variable: 'UNICASTRTP_LOCAL_ADDRESS' });
    this.assertActive();
    const port = await this.ari.request('GET', `/channels/${this.externalId}/variable`,
      { variable: 'UNICASTRTP_LOCAL_PORT' });
    this.assertActive();
    const host = address?.value;
    const portNumber = Number(port?.value);
    let isLocal = isIP(host || '') === 4 && host.startsWith('127.');
    if (!isLocal && isIP(host || '') === 4) {
      try { isLocal = Object.values(networkInterfaces()).flat().filter(Boolean).some((item) => item.address === host); }
      catch { throw new Error('STOP/HOLD: невозможно подтвердить, что RTP адрес ExternalMedia принадлежит этому VPS.'); }
    }
    if (isIP(host || '') !== 4 || !isLocal ||
        !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      throw new Error('STOP/HOLD: ExternalMedia не вернул корректный локальный RTP адрес/порт. Порт не подставляется вручную.');
    }
    this.mediaEndpoint = { host, port: portNumber };
    await this.ari.request('POST', `/bridges/${this.bridgeId}/addChannel`, { channel: this.externalId });
    this.assertActive();
    this.mediaActive = true;
    this.pacer.start();
    this.live.greet();
    this.log('Телефон ответил. Двусторонняя передача PCMU включена. Для остановки: Ctrl+C.');
  }

  handleAriEvent(event) {
    if (this.closing) return;
    const id = event.channel?.id;
    if (id !== this.phoneId && id !== this.externalId) return;
    if (event.type === 'StasisEnd' || event.type === 'ChannelDestroyed') {
      if (id === this.externalId) {
        void this.cleanup('ExternalMedia завершён', new Error('Канал ExternalMedia неожиданно завершился.'));
      } else if (!this.mediaActive) {
        void this.cleanup('Телефонный канал завершён', new Error('Вызов не дошёл до разговора: занят, отказ, таймаут или ранний сброс.'));
      } else void this.cleanup('Телефон завершил звонок');
    }
  }

  receiveRtp(packet, remote) {
    if (!this.mediaActive || this.closing) return;
    if (remote.address !== this.mediaEndpoint.host || remote.port !== this.mediaEndpoint.port) {
      this.stats.foreignPackets++; return;
    }
    const parsed = parseRtp(packet, [this.config.payloadType]);
    if (!parsed) { this.stats.invalidPackets++; return; }
    if (this.inputSsrc === parsed.ssrc && this.inputSequence !== undefined) {
      const forward = (parsed.sequence - this.inputSequence) & 0xffff;
      if (!forward || forward >= 0x8000) { this.stats.stalePackets++; return; }
    }
    this.inputSsrc = parsed.ssrc; this.inputSequence = parsed.sequence;
    try {
      this.live.appendAudio(parsed.payload);
      this.stats.inputPackets++; this.stats.inputBytes += parsed.payload.length;
    } catch (error) { void this.cleanup('Не удалось передать звук OpenAI', error); }
  }

  sendFrame(frame) {
    if (!this.mediaActive || this.closing) return;
    this.udp.send(this.packetizer.next(frame), this.mediaEndpoint.port, this.mediaEndpoint.host, (error) => {
      if (error && !this.closing) void this.cleanup('Ошибка отправки RTP', new Error('Не удалось отправить RTP в Asterisk.'));
    });
    this.stats.outputPackets++;
  }

  cleanup(reason = 'Остановка', error) {
    if (this.cleanupPromise) return this.cleanupPromise;
    // Set the fence synchronously; no more audio or resource creation past it.
    this.closing = true;
    this.mediaActive = false;
    this.abort.abort();
    this.pacer.stop();
    if (error) {
      this.failed = true;
      this.warn(`${reason}: ${safeMessage(error, this.config)}`);
    } else this.log(reason);
    this.cleanupPromise = Promise.resolve().then(() => this.finishCleanup());
    return this.cleanupPromise;
  }

  async finishCleanup() {
    try {
      // A REST response can arrive after hangup. Wait for the bounded in-flight
      // startup operation before deleting known IDs so late resources cannot leak.
      await this.startTask?.catch(() => {});
      const attempt = async (label, action) => {
        try { await action(); }
        catch (error) { this.failed = true; this.warn(`${label}: ${safeMessage(error, this.config)}`); }
      };
      if (this.phoneAttempted) await attempt(`Не удалён телефонный канал ${this.phoneId}`,
        () => this.ari.request('DELETE', `/channels/${this.phoneId}`, {}, { ignoreMissing: true }));
      await attempt('Ошибка закрытия OpenAI', async () => {
        const confirmed = await this.live.close();
        if (!confirmed) { this.failed = true; this.warn('OpenAI: session.closed не получен; окончательное завершение сессии не подтверждено.'); }
      });
      if (this.externalAttempted) await attempt(`Не удалён ExternalMedia ${this.externalId}`,
        () => this.ari.request('DELETE', `/channels/${this.externalId}`, {}, { ignoreMissing: true }));
      if (this.bridgeAttempted) await attempt(`Не удалён bridge ${this.bridgeId}`,
        () => this.ari.request('DELETE', `/bridges/${this.bridgeId}`, {}, { ignoreMissing: true }));
      await attempt('Ошибка закрытия UDP', () => new Promise((resolve) => {
        try { this.udp.close(resolve); } catch { resolve(); }
      }));
    } finally {
      this.ari.close();
      this.log(`RTP: принято ${this.stats.inputPackets} пакетов / ${this.stats.inputBytes} PCMU bytes; отправлено ${this.stats.outputPackets} пакетов (включая тишину); некорректных ${this.stats.invalidPackets}; чужих ${this.stats.foreignPackets}; повторных/старых ${this.stats.stalePackets}.`);
      this.resolveDone({ failed: this.failed, stats: this.stats });
    }
  }
}
