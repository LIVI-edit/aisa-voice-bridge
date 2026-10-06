import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { CallSession } from '../src/call-session.js';
import { buildRtp, parseRtp } from '../src/rtp.js';

const config = { ariUrl: 'http://127.0.0.1:8088/ari', ariUser: 'test', ariPassword: 'dummy-password',
  apiKey: 'dummy-api-key', endpoint: '220546', bindAddress: '127.0.0.1', payloadType: 0,
  requestTimeoutMs: 100, answerTimeoutSeconds: 1, maxQueueFrames: 100 };
class FakeAri extends EventEmitter {
  constructor() { super(); this.calls = []; this.closed = false; }
  async connect() {}
  async request(method, path, params = {}, options) {
    this.calls.push({ method, path, params, options });
    if (this.hook) await this.hook(method, path, params);
    if (method === 'POST' && (path === '/channels' || path === '/channels/externalMedia')) {
      this.emit('event', { type: 'StasisStart', channel: { id: params.channelId, state: 'Up' } });
      return { id: params.channelId };
    }
    if (params.variable === 'UNICASTRTP_LOCAL_ADDRESS') return { value: '127.0.0.1' };
    if (params.variable === 'UNICASTRTP_LOCAL_PORT') return { value: String(this.rtpPort || 34567) };
    return null;
  }
  close() { this.closed = true; }
}
class FakeLive extends EventEmitter {
  constructor() { super(); this.input = []; this.closeCalls = 0; }
  async connect() {}
  appendAudio(bytes) { this.input.push(Buffer.from(bytes)); }
  greet() { this.emit('greet'); }
  async close() { this.closeCalls++; return true; }
}
class FakeUdp extends EventEmitter {
  constructor() { super(); this.sent = []; this.closed = false; }
  bind(port, host) { this.host = host; queueMicrotask(() => this.emit('listening')); }
  address() { return { port: 45678, address: '127.0.0.1' }; }
  send(packet, port, host, callback) { this.sent.push({ packet, port, host }); callback(); }
  close(callback) { this.closed = true; callback(); }
}
function fixture() {
  const ari = new FakeAri(); const live = new FakeLive(); const udp = new FakeUdp();
  const logs = []; const errors = [];
  const session = new CallSession(config, '+380991234567', { ari, live, udp,
    log: (message) => logs.push(message), warn: (message) => errors.push(message) });
  return { ari, live, udp, session, logs, errors };
}
// Don't return the call's pending promise from an async helper: it would assimilate
// it and wait for hangup. Keep the run handle explicitly at each test instead.
async function start(f) {
  const ready = once(f.live, 'greet'); f.running = f.session.run();
  await Promise.race([ready, f.running.then(() => { throw new Error(f.errors.join('\n') || 'Call ended before greeting'); })]);
}

test('answered call uses exact Zadarma route, mixing bridge, ExternalMedia and ARI-discovered port', async () => {
  const f = fixture(); f.ari.rtpPort = 54321; await start(f);
  const origin = f.ari.calls.find((call) => call.path === '/channels');
  assert.equal(origin.params.endpoint, 'PJSIP/380991234567@220546');
  assert.equal(f.session.number, '+380991234567');
  assert.equal(f.session.zadarmaNumber, '380991234567');
  assert.equal(origin.params.formats, 'ulaw');
  assert.equal(f.ari.calls.find((call) => call.path === `/bridges/${f.session.bridgeId}`).params.type, 'mixing,proxy_media');
  const external = f.ari.calls.find((call) => call.path === '/channels/externalMedia');
  assert.equal(external.params.external_host, '127.0.0.1:45678');
  assert.equal(external.params.format, 'ulaw'); assert.equal(external.params.direction, 'both');
  assert.equal(external.params.transport, 'udp'); assert.equal(external.params.encapsulation, 'rtp');
  assert.deepEqual(f.session.mediaEndpoint, { host: '127.0.0.1', port: 54321 });
  f.session.sendFrame(Buffer.alloc(160, 5));
  assert.equal(f.udp.sent[0].port, 54321); assert.equal(f.udp.sent[0].host, '127.0.0.1');
  assert.deepEqual(parseRtp(f.udp.sent[0].packet).payload, Buffer.alloc(160, 5));
  await f.session.cleanup('test'); assert.equal((await f.running).failed, false);
});
test('input RTP extracts only PCMU bytes; rejects foreign, invalid, duplicate and stale packets', async () => {
  const f = fixture(); await start(f);
  const remote = { address: '127.0.0.1', port: 34567 };
  const packet = buildRtp(Buffer.alloc(160, 3), { sequence: 100, timestamp: 0, ssrc: 1 });
  f.udp.emit('message', packet, { ...remote, port: 99 });
  f.udp.emit('message', Buffer.alloc(5), remote);
  f.udp.emit('message', packet, remote); f.udp.emit('message', packet, remote);
  f.udp.emit('message', buildRtp(Buffer.alloc(160), { sequence: 99, timestamp: 0, ssrc: 1 }), remote);
  assert.deepEqual(f.live.input, [Buffer.alloc(160, 3)]);
  assert.equal(f.session.stats.foreignPackets, 1); assert.equal(f.session.stats.invalidPackets, 1);
  assert.equal(f.session.stats.stalePackets, 2);
  await f.session.cleanup(); await f.running;
});
test('phone hangup cleans every resource once and fences late audio', async () => {
  const f = fixture(); await start(f); f.live.emit('audio', Buffer.alloc(321));
  f.ari.emit('event', { type: 'StasisEnd', channel: { id: f.session.phoneId } });
  const first = f.session.cleanup(); assert.equal(f.session.cleanup(), first);
  f.live.emit('audio', Buffer.alloc(160)); f.session.sendFrame(Buffer.alloc(160));
  await first; await f.running;
  assert.equal(f.session.queue.bytes, 0); assert.equal(f.udp.sent.length, 0);
  assert.equal(f.live.closeCalls, 1); assert.equal(f.udp.closed, true); assert.equal(f.ari.closed, true);
  assert.deepEqual(f.ari.calls.filter((call) => call.method === 'DELETE').map((call) => call.path),
    [`/channels/${f.session.phoneId}`, `/channels/${f.session.externalId}`, `/bridges/${f.session.bridgeId}`]);
});
test('OpenAI failure hangs up phone, clears media and returns failure', async () => {
  const f = fixture(); await start(f);
  f.live.emit('fault', new Error('dummy-api-key dummy-password'));
  const result = await f.running;
  assert.equal(result.failed, true); assert.equal(f.udp.closed, true);
  assert.ok(f.ari.calls.some((call) => call.method === 'DELETE' && call.path === `/channels/${f.session.phoneId}`));
  assert.equal(f.errors.join(' ').includes('dummy-api-key'), false);
  assert.equal(f.errors.join(' ').includes('dummy-password'), false);
});
test('hangup during ExternalMedia creation waits for late REST response then deletes resource', async () => {
  const f = fixture(); let release; const pending = new Promise((resolve) => { release = resolve; });
  let entered; const reached = new Promise((resolve) => { entered = resolve; });
  f.ari.hook = async (method, path) => {
    if (method === 'POST' && path === '/channels/externalMedia') { entered(); await pending; }
  };
  f.running = f.session.run(); await reached;
  f.ari.emit('event', { type: 'StasisEnd', channel: { id: f.session.phoneId } });
  assert.equal(f.session.closing, true);
  assert.equal(f.ari.calls.some((call) => call.method === 'DELETE'), false);
  release(); await f.running;
  assert.ok(f.ari.calls.some((call) => call.method === 'DELETE' && call.path === `/channels/${f.session.externalId}`));
  assert.equal(f.ari.calls.some((call) => call.params.variable), false);
  assert.equal(f.udp.closed, true);
});
test('REST failure before answer releases waits, UDP and OpenAI; no later bridge is created', async () => {
  const f = fixture(); f.ari.hook = async (method, path) => {
    if (path === '/channels' && method === 'POST') throw new Error('originate failed');
  };
  const result = await f.session.run(); assert.equal(result.failed, true);
  assert.equal(f.live.closeCalls, 1); assert.equal(f.udp.closed, true);
  assert.equal(f.ari.calls.some((call) => call.path.startsWith('/bridges/')), false);
});
test('invalid discovered ExternalMedia port fails instead of using a guessed port', async () => {
  const f = fixture(); f.ari.rtpPort = 99999;
  const result = await f.session.run(); assert.equal(result.failed, true);
  assert.match(f.errors.join(' '), /STOP\/HOLD/); assert.equal(f.udp.sent.length, 0);
});
test('audio queue overflow fails the call and releases resources', async () => {
  const f = fixture(); await start(f); f.live.emit('audio', Buffer.alloc(16001));
  assert.equal((await f.running).failed, true); assert.equal(f.session.queue.bytes, 0);
  assert.match(f.errors.join(' '), /переполнена/);
});
