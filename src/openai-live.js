import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export class OpenAILive extends EventEmitter {
  constructor(config, { createSocket = (url, options) => new WebSocket(url, options) } = {}) {
    super();
    this.config = config;
    this.createSocket = createSocket;
    this.started = false;
    this.closing = false;
    this.finalized = false;
  }
  connect() {
    const socket = this.socket = this.createSocket('wss://api.openai.com/v1/live/sessions', {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      handshakeTimeout: this.config.connectTimeoutMs,
      maxPayload: 1024 * 1024,
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      const fail = (error) => {
        finish(error);
        if (!this.closing) this.emit('fault', error);
      };
      const timer = setTimeout(() => {
        fail(new Error('OpenAI: не получен session.started за 15 секунд.'));
        socket.terminate();
      }, this.config.connectTimeoutMs);
      socket.on('open', () => {
        const audio = { format: { type: 'audio/pcmu', rate: 8000 } };
        if (this.config.voice) audio.output = { voice: this.config.voice };
        try {
          this.send({ type: 'session.start', session: {
            model: 'gpt-live-1', instructions: this.config.instructions, audio,
          } });
        } catch (error) { fail(error); }
      });
      socket.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          if (event.type === 'session.started') {
            const format = event.session?.audio?.format;
            if (event.session?.model !== 'gpt-live-1' ||
                format?.type !== 'audio/pcmu' || format?.rate !== 8000) {
              fail(new Error('STOP/HOLD: OpenAI не подтвердил gpt-live-1 / audio/pcmu 8000.'));
              return;
            }
            this.started = true; finish();
          } else if (event.type === 'session.output_audio.delta' && !this.closing) {
            if (typeof event.delta !== 'string' || event.delta.length % 4 !== 0 ||
                !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.delta)) {
              throw new Error('OpenAI: некорректный base64 аудио.');
            }
            this.emit('audio', Buffer.from(event.delta, 'base64'));
          } else if (event.type === 'session.closed') {
            this.finalized = true;
            this.emit('finalized');
            if (!this.closing) fail(new Error('OpenAI завершил голосовую сессию.'));
          } else if (event.type === 'error') {
            // Server messages can echo supplied values; expose only bounded code/param.
            const code = String(event.error?.code || 'unknown').replace(/[^\w.-]/g, '').slice(0, 80);
            fail(new Error(`OpenAI API: ${code}. Проверьте доступ к модели и параметры сессии.`));
          }
        } catch (error) { fail(error); }
      });
      socket.on('error', () => fail(new Error('OpenAI WebSocket: ошибка соединения или авторизации.')));
      socket.on('close', () => {
        finish(new Error('OpenAI WebSocket закрыт до запуска сессии.'));
        this.emit('transportClosed');
        if (!this.closing && !this.finalized) fail(new Error('OpenAI WebSocket неожиданно закрыт.'));
      });
    });
  }
  send(event) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('OpenAI WebSocket не открыт.');
    this.socket.send(JSON.stringify(event), (error) => {
      if (error && !this.closing) this.emit('fault', new Error('OpenAI: не удалось отправить данные.'));
    });
  }
  appendAudio(bytes) {
    if (!this.started || this.closing || !bytes.length) return;
    // Bound ws's internal send buffer as well as our RTP output queue.
    if (this.socket.bufferedAmount > 128 * 1024) throw new Error('OpenAI не успевает принимать звук.');
    this.send({ type: 'session.input_audio.append', audio: bytes.toString('base64') });
  }
  greet() {
    this.send({ type: 'session.instructions.append',
      delegation_id: null,
      content: 'The telephone caller has now answered and can hear you. Greet them now, briefly, and continue the short connection test.' });
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }
  async finishClose() {
    const socket = this.socket;
    if (!socket) return true;
    if (this.started && !this.finalized && socket.readyState === WebSocket.OPEN) {
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.off('finalized', done); this.off('transportClosed', done);
          resolve();
        };
        const timer = setTimeout(done, this.config.closeTimeoutMs);
        this.once('finalized', done); this.once('transportClosed', done);
        try { this.send({ type: 'session.close' }); } catch { done(); }
      });
    }
    if (socket.readyState === WebSocket.OPEN) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1000);
        socket.once('close', () => { clearTimeout(timer); resolve(); });
        socket.close();
      });
    } else socket.terminate();
    return this.finalized || !this.started;
  }
}
