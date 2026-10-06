import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OpenAILive } from '../src/openai-live.js';

class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 0; this.bufferedAmount = 0; this.sent = []; }
  send(data, callback) { this.sent.push(JSON.parse(data)); callback?.(); }
  terminate() { this.readyState = 3; this.emit('close'); }
  close() { this.terminate(); }
  open() { this.readyState = 1; this.emit('open'); }
  event(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
}
function fixture(extra = {}) {
  const socket = new Socket(); let url, options;
  const live = new OpenAILive({ apiKey: 'dummy-not-real', instructions: 'test',
    connectTimeoutMs: 50, closeTimeoutMs: 20, ...extra }, {
    createSocket: (u, o) => { url = u; options = o; return socket; },
  });
  live.on('fault', () => {});
  return { socket, live, transport: () => ({ url, options }) };
}
function started(socket) { socket.event({ type: 'session.started', session: {
  model: 'gpt-live-1', audio: { format: { type: 'audio/pcmu', rate: 8000 } },
} }); }

test('exact Live endpoint, Bearer header and session.start; waits for session.started', async () => {
  const { socket, live, transport } = fixture({ voice: 'marin' });
  const connected = live.connect(); socket.open();
  assert.equal(live.started, false);
  assert.equal(transport().url, 'wss://api.openai.com/v1/live/sessions');
  assert.equal(transport().options.headers.Authorization, 'Bearer dummy-not-real');
  assert.deepEqual(socket.sent[0], { type: 'session.start', session: {
    model: 'gpt-live-1', instructions: 'test', audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'marin' } },
  } });
  started(socket); await connected; assert.equal(live.started, true);
  socket.event({ type: 'session.closed' }); await live.close();
});
test('raw audio preserved; greeting sends full Live event with delegation_id null and exact content', async () => {
  const { socket, live } = fixture(); const connected = live.connect(); socket.open(); started(socket); await connected;
  const bytes = Buffer.from([0, 1, 128, 255]); live.appendAudio(bytes);
  assert.deepEqual(socket.sent[1], { type: 'session.input_audio.append', audio: bytes.toString('base64') });
  let output; live.on('audio', (chunk) => { output = chunk; });
  socket.event({ type: 'session.output_audio.delta', delta: bytes.toString('base64') }); assert.deepEqual(output, bytes);
  live.greet();
  assert.deepEqual(socket.sent[2], {
    type: 'session.instructions.append',
    delegation_id: null,
    content: 'The telephone caller has now answered and can hear you. Greet them now, briefly, and continue the short connection test.',
  });
  socket.event({ type: 'session.closed' }); await live.close();
});
test('mismatched codec confirmation yields STOP/HOLD', async () => {
  const { socket, live } = fixture(); const connected = live.connect(); socket.open();
  socket.event({ type: 'session.started', session: { model: 'gpt-live-1', audio: { format: { type: 'audio/pcm', rate: 24000 } } } });
  await assert.rejects(connected, /STOP\/HOLD/); await live.close();
});
test('cleanup waits for session.closed; repeated close has same promise and audio stops', async () => {
  const { socket, live } = fixture(); const connected = live.connect(); socket.open(); started(socket); await connected;
  const closing = live.close(); assert.equal(live.close(), closing);
  assert.equal(socket.sent.at(-1).type, 'session.close');
  live.appendAudio(Buffer.alloc(160)); assert.equal(socket.sent.at(-1).type, 'session.close');
  assert.equal(socket.readyState, 1);
  socket.event({ type: 'session.closed' }); assert.equal(await closing, true); assert.equal(socket.readyState, 3);
});
test('cleanup timeout returns unconfirmed finalization and closes socket', async () => {
  const { socket, live } = fixture(); const connected = live.connect(); socket.open(); started(socket); await connected;
  assert.equal(await live.close(), false); assert.equal(socket.readyState, 3);
});
test('startup timeout and transport failure reject instead of hanging', async () => {
  const first = fixture({ connectTimeoutMs: 5 });
  await assert.rejects(first.live.connect(), /session.started/); await first.live.close();
  const second = fixture(); const connected = second.live.connect(); second.socket.emit('error', new Error('do not log this'));
  await assert.rejects(connected, /ошибка соединения/); await second.live.close();
});
test('OpenAI error details do not echo server message containing secrets', async () => {
  const { socket, live } = fixture(); const connected = live.connect(); socket.open();
  socket.event({ type: 'error', error: { code: 'invalid_api_key', message: 'dummy-not-real' } });
  await assert.rejects(connected, (error) => /invalid_api_key/.test(error.message) && !/dummy-not-real/.test(error.message));
  await live.close();
});
