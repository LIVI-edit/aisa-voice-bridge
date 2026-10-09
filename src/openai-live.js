import { EventEmitter } from 'node:events';
const WS_OPEN = 1;

async function defaultCreateSocket(url, options) {
  const { default: WebSocket } = await import('ws');
  return new WebSocket(url, options);
}

function validTranscriptEvent(event) {
  return typeof event.event_id === 'string' && event.event_id.length > 0 && event.event_id.length <= 512 &&
    typeof event.delta === 'string' && event.delta.length > 0 && Buffer.byteLength(event.delta) <= 8192 &&
    Number.isInteger(event.start_ms) && event.start_ms >= 0 && Number.isInteger(event.end_ms) && event.end_ms >= event.start_ms;
}

export class OpenAILive extends EventEmitter {
  constructor(config, { createSocket = defaultCreateSocket } = {}) {
    super(); this.config = config; this.createSocket = createSocket;
    this.started = false; this.closing = false; this.finalized = false;
    this.latestUsageSeconds = null; this.finalUsageSeconds = null; this.sessionId = null; this.delegationFallbacks = 0;
  }
  async connect() {
    const created = this.createSocket('wss://api.openai.com/v1/live/sessions', {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      handshakeTimeout: this.config.connectTimeoutMs, maxPayload: 1024 * 1024,
    });
    const socket = this.socket = created && typeof created.then === 'function' ? await created : created;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
      const fail = (error) => { finish(error); if (!this.closing) this.emit('fault', error); };
      const timer = setTimeout(() => { fail(new Error('OpenAI: session.started timeout.')); socket.terminate?.(); }, this.config.connectTimeoutMs);
      socket.on('open', () => {
        const audio = { format: { type: 'audio/pcmu', rate: 8000 } };
        if (this.config.voice) audio.output = { voice: this.config.voice };
        try {
          const input = this.config.inputDataJson ? [{ type:'message', role:'user', content:[{ type:'input_text', text:this.config.inputDataJson }] }] : [];
          this.send({ type: 'session.start', session: { model: 'gpt-live-1', instructions: this.config.instructions || '', input, audio, store: false } });
        }
        catch (e) { fail(e); }
      });
      socket.on('message', (data) => {
        let event;
        try { event = JSON.parse(data.toString()); } catch { fail(new Error('OpenAI returned malformed event.')); return; }
        try {
          if (event.type === 'session.started') {
            const format = event.session?.audio?.format;
            if (event.session?.model !== 'gpt-live-1' || format?.type !== 'audio/pcmu' || format?.rate !== 8000) {
              fail(new Error('STOP/HOLD: OpenAI did not confirm gpt-live-1 / audio/pcmu 8000.')); return;
            }
            this.sessionId = event.session?.id || null; this.started = true; this.emit('sessionStarted', { sessionId: this.sessionId, event }); finish();
          } else if (event.type === 'session.output_audio.delta' && !this.closing) {
            if (typeof event.delta !== 'string' || event.delta.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.delta)) throw new Error('OpenAI: invalid base64 audio.');
            this.emit('audio', Buffer.from(event.delta, 'base64'));
          } else if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
            if (!validTranscriptEvent(event)) { this.emit('transcriptInvalid', { type: event.type }); return; }
            this.emit('transcript', { eventId: event.event_id, speaker: event.type.includes('input_') ? 'user' : 'assistant', delta: event.delta, startMs: event.start_ms, endMs: event.end_ms });
          } else if (event.type === 'session.usage.updated') {
            const seconds = event.usage?.seconds;
            if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) { this.latestUsageSeconds = seconds; this.emit('usage', seconds); }
          } else if (event.type === 'session.delegation.created') {
            const delegationId = event.delegation?.id;
            if (typeof delegationId !== 'string' || !delegationId) { this.emit('delegationInvalid'); return; }
            this.delegationFallbacks += 1;
            if (this.delegationFallbacks <= 3) {
              this.send({ type: 'session.commentary.append', delegation_id: delegationId,
                content: 'Це питання або дія потребує участі команди LiVi Edit. Я не виконую зовнішні дії під час дзвінка; можу зафіксувати запит для людини.' });
              this.emit('delegationFallback', { delegationId, count: this.delegationFallbacks });
            } else this.emit('delegationLimit', { delegationId, count: this.delegationFallbacks });
          } else if (event.type === 'session.closed') {
            const seconds = event.usage?.seconds;
            if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) this.finalUsageSeconds = seconds;
            this.finalized = true; this.emit('finalized', { reason: event.reason || null, finalUsageSeconds: this.finalUsageSeconds });
            if (!this.closing) fail(new Error('OpenAI Live session closed.'));
          } else if (event.type === 'error') {
            const code = String(event.error?.code || 'unknown').replace(/[^\w.-]/g, '').slice(0, 80);
            fail(new Error(`OpenAI API: ${code}.`));
          }
        } catch (error) { fail(error); }
      });
      socket.on('error', () => fail(new Error('OpenAI WebSocket connection/auth error.')));
      socket.on('close', () => { finish(new Error('OpenAI WebSocket closed before session start.')); this.emit('transportClosed'); if (!this.closing && !this.finalized) fail(new Error('OpenAI WebSocket unexpectedly closed.')); });
    });
  }
  send(event) {
    if (this.socket?.readyState !== WS_OPEN) throw new Error('OpenAI WebSocket is not open.');
    this.socket.send(JSON.stringify(event), (error) => { if (error) this.emit('fault', new Error('OpenAI WebSocket send failed.')); });
  }
  appendAudio(bytes) {
    if (!this.started || this.closing || !bytes?.length) return;
    if (this.socket.bufferedAmount > 128 * 1024) throw new Error('OpenAI input buffer is backpressured.');
    this.send({ type: 'session.input_audio.append', audio: bytes.toString('base64') });
  }
  greet(content) {
    if (typeof content !== 'string' || !content.trim()) throw new Error('Greeting instruction is required.');
    this.send({ type: 'session.instructions.append', delegation_id: null, content });
  }
  close() { if (this.closePromise) return this.closePromise; this.closing = true; this.closePromise = this.finishClose(); return this.closePromise; }
  async finishClose() {
    const socket = this.socket; if (!socket) return { confirmed: true, finalUsageSeconds: this.finalUsageSeconds };
    if (this.started && !this.finalized && socket.readyState === WS_OPEN) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); this.off('finalized', done); this.off('transportClosed', done); resolve(); };
        const timer = setTimeout(done, this.config.closeTimeoutMs); this.once('finalized', done); this.once('transportClosed', done);
        try { this.send({ type: 'session.close' }); } catch { done(); }
      });
    }
    if (socket.readyState === WS_OPEN) {
      await new Promise((resolve) => { const timer = setTimeout(() => { socket.terminate?.(); resolve(); }, 1000); socket.once('close', () => { clearTimeout(timer); resolve(); }); socket.close?.(); });
    } else socket.terminate?.();
    return { confirmed: this.finalized || !this.started, finalUsageSeconds: this.finalUsageSeconds, latestUsageSeconds: this.latestUsageSeconds };
  }
}
