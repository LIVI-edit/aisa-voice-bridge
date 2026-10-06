import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AriClient, waitForAriEvent } from '../src/ari.js';

const config = { ariUrl: 'http://127.0.0.1:8088/ari', ariUser: 'bridge',
  ariPassword: 'dummy-password', requestTimeoutMs: 50 };
test('ARI REST encodes endpoint and parameters, authenticates via Basic header, reads variables', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: new URL(url), options });
    return new Response(JSON.stringify({ value: '34567' }), { status: 200 });
  });
  const ari = new AriClient(config, 'test-app');
  await ari.request('POST', '/channels', { endpoint: 'PJSIP/+380991234567@220546', app: 'test-app' });
  assert.equal(requests[0].url.searchParams.get('endpoint'), 'PJSIP/+380991234567@220546');
  assert.equal(requests[0].url.username, ''); assert.equal(requests[0].url.searchParams.has('api_key'), false);
  assert.equal(requests[0].options.headers.Authorization, `Basic ${Buffer.from('bridge:dummy-password').toString('base64')}`);
  const variable = await ari.request('GET', '/channels/test-id/variable', { variable: 'UNICASTRTP_LOCAL_PORT' });
  assert.equal(variable.value, '34567');
});
test('cleanup ignores only 404; other HTTP errors and fetch failures remain visible without credentials', async (t) => {
  const ari = new AriClient(config, 'test-app');
  t.mock.method(globalThis, 'fetch', async () => new Response('secret body', { status: 404 }));
  assert.equal(await ari.request('DELETE', '/channels/id', {}, { ignoreMissing: true }), null);
  await assert.rejects(ari.request('GET', '/channels/id'), /HTTP 404/);
  globalThis.fetch = async () => new Response('dummy-password', { status: 401 });
  await assert.rejects(ari.request('DELETE', '/channels/id', {}, { ignoreMissing: true }),
    (error) => /HTTP 401/.test(error.message) && !/dummy-password/.test(error.message));
  globalThis.fetch = async () => { throw new Error('dummy-password'); };
  await assert.rejects(ari.request('GET', '/channels'), (error) => /ARI REST/.test(error.message) && !/dummy-password/.test(error.message));
});
test('ARI event wait subscribes before action and releases all listeners on success', async () => {
  const ari = new EventEmitter(); const signal = new AbortController();
  const waiting = waitForAriEvent(ari, (event) => event.channel?.id === 'target', 100, signal.signal);
  ari.emit('event', { channel: { id: 'other' } }); ari.emit('event', { channel: { id: 'target' } });
  assert.equal((await waiting).channel.id, 'target');
  assert.equal(ari.listenerCount('event'), 0); assert.equal(ari.listenerCount('fault'), 0);
});
test('ARI wait supports abort, fault and finite timeout without leaking listeners', async () => {
  for (const mode of ['abort', 'fault', 'timeout']) {
    const ari = new EventEmitter(); const signal = new AbortController();
    const waiting = waitForAriEvent(ari, () => false, 5, signal.signal);
    if (mode === 'abort') signal.abort();
    if (mode === 'fault') ari.emit('fault', new Error('fault'));
    await assert.rejects(waiting);
    assert.equal(ari.listenerCount('event'), 0); assert.equal(ari.listenerCount('fault'), 0);
  }
});
