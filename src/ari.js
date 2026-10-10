import { EventEmitter } from 'node:events';

async function defaultCreateSocket(url, options) {
  const { default: WebSocket } = await import('ws');
  return new WebSocket(url, options);
}

export class AriClient extends EventEmitter {
  constructor(config, app, { fetchImpl, createSocket = defaultCreateSocket } = {}) {
    super();
    this.config = config; this.app = app; this.fetchImpl = fetchImpl; this.createSocket = createSocket;
    this.authorization = `Basic ${Buffer.from(`${config.ariUser}:${config.ariPassword}`).toString('base64')}`;
    this.closing = false;
  }
  async request(method, path, params = {}, { ignoreMissing = false, variables = null } = {}) {
    const url = new URL(`${this.config.ariUrl}${path}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const headers = { Authorization: this.authorization };
    let body;
    if (variables !== null) {
      if (!variables || typeof variables !== 'object' || Array.isArray(variables)) throw new Error('ARI variables must be an object.');
      headers['Content-Type'] = 'application/json'; body = JSON.stringify({ variables });
    }
    let response;
    try {
      response = await (this.fetchImpl || globalThis.fetch)(url, { method, headers, body, signal: AbortSignal.timeout(this.config.requestTimeoutMs) });
    } catch { throw new Error('ARI REST unavailable or timed out.'); }
    if (ignoreMissing && response.status === 404) return null;
    if (!response.ok) throw Object.assign(new Error(`ARI ${method} ${path}: HTTP ${response.status}.`), { code: 'ari_http_error', status: response.status });
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { throw new Error('ARI returned malformed JSON.'); }
  }
  async exists(path) {
    try { await this.request('GET', path); return true; }
    catch (error) { if (error?.status === 404) return false; throw error; }
  }
  async connect() {
    const url = new URL(`${this.config.ariUrl}/events`); url.protocol = 'ws:'; url.searchParams.set('app', this.app);
    const created = this.createSocket(url, { headers: { Authorization: this.authorization }, handshakeTimeout: this.config.connectTimeoutMs, maxPayload: 1024 * 1024 });
    const socket = this.socket = created && typeof created.then === 'function' ? await created : created;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => { finish(new Error('ARI WebSocket connection timed out.')); socket.terminate?.(); }, this.config.connectTimeoutMs);
      socket.on('open', () => finish());
      socket.on('message', (data) => { try { this.emit('event', JSON.parse(data.toString())); } catch { this.emit('fault', new Error('ARI returned malformed event.')); } });
      socket.on('error', () => { const e = new Error('ARI WebSocket connection error.'); finish(e); if (!this.closing) this.emit('fault', e); });
      socket.on('close', () => { const e = new Error('ARI WebSocket closed.'); finish(e); if (!this.closing) this.emit('fault', e); });
    });
  }
  close() { this.closing = true; this.socket?.terminate?.(); }
}

export function waitForAriEvent(ari, predicate, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, event) => { if (done) return; done = true; clearTimeout(timer); ari.off('event', onEvent); ari.off('fault', onFault); signal?.removeEventListener('abort', onAbort); error ? reject(error) : resolve(event); };
    const onEvent = (event) => { if (predicate(event)) finish(null, event); };
    const onFault = (error) => finish(error);
    const onAbort = () => finish(new Error('ARI wait aborted.'));
    const timer = setTimeout(() => finish(new Error('Timed out waiting for ARI event.')), timeoutMs);
    ari.on('event', onEvent); ari.on('fault', onFault); signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort();
  });
}
