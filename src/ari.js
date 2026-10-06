import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export class AriClient extends EventEmitter {
  constructor(config, app) {
    super();
    this.config = config;
    this.app = app;
    this.authorization = `Basic ${Buffer.from(`${config.ariUser}:${config.ariPassword}`).toString('base64')}`;
    this.closing = false;
  }
  async request(method, path, params = {}, { ignoreMissing = false } = {}) {
    const url = new URL(`${this.config.ariUrl}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await fetch(url, { method, headers: { Authorization: this.authorization },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs) });
    } catch { throw new Error('ARI REST недоступен или превышено время ожидания. Проверьте Asterisk и localhost:8088.'); }
    if (ignoreMissing && response.status === 404) return null;
    // Never print HTTP bodies, request objects or credentials.
    if (!response.ok) throw new Error(`ARI ${method} ${path}: HTTP ${response.status}.`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  connect() {
    const url = new URL(`${this.config.ariUrl}/events`);
    url.protocol = 'ws:';
    url.searchParams.set('app', this.app);
    const socket = this.socket = new WebSocket(url, {
      headers: { Authorization: this.authorization },
      handshakeTimeout: this.config.connectTimeoutMs, maxPayload: 1024 * 1024,
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => {
        finish(new Error('ARI WebSocket: время подключения истекло.'));
        socket.terminate();
      }, this.config.connectTimeoutMs);
      socket.on('open', () => finish());
      socket.on('message', (data) => {
        try { this.emit('event', JSON.parse(data.toString())); }
        catch { this.emit('fault', new Error('ARI вернул некорректное событие.')); }
      });
      socket.on('error', () => {
        const error = new Error('ARI WebSocket: ошибка соединения. Проверьте учётные данные и ARI.');
        finish(error);
        if (!this.closing) this.emit('fault', error);
      });
      socket.on('close', () => {
        const error = new Error('Соединение ARI закрыто.');
        finish(error);
        if (!this.closing) this.emit('fault', error);
      });
    });
  }
  close() { this.closing = true; this.socket?.terminate(); }
}

// Install BEFORE originating/creating channels: StasisStart can beat REST's response.
export function waitForAriEvent(ari, predicate, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const finish = (error, event) => {
      clearTimeout(timer);
      ari.off('event', onEvent);
      ari.off('fault', onFault);
      signal?.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve(event);
    };
    const onEvent = (event) => { if (predicate(event)) finish(null, event); };
    const onFault = (error) => finish(error);
    const onAbort = () => finish(new Error('Ожидание ARI отменено.'));
    const timer = setTimeout(() => finish(new Error('Не получено ожидаемое событие ARI.')), timeoutMs);
    ari.on('event', onEvent);
    ari.on('fault', onFault);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
