import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, validateNumber, normalizeZadarmaNumber, safeMessage } from '../src/config.js';
const env = { OPENAI_API_KEY: 'dummy-key', ASTERISK_ARI_USER: 'bridge', ASTERISK_ARI_PASSWORD: 'dummy-password' };
test('config has localhost ARI, PCMU PT0 and default Zadarma endpoint', () => {
  const config = loadConfig(env);
  assert.equal(config.ariUrl, 'http://127.0.0.1:8088/ari');
  assert.equal(config.endpoint, '220546'); assert.equal(config.payloadType, 0);
});
test('external ARI, URL credentials, wrong static codec PT, public UDP bind and missing secrets rejected', () => {
  for (const extra of [{ ASTERISK_ARI_URL: 'http://example.com:8088/ari' },
    { ASTERISK_ARI_URL: 'http://u:p@127.0.0.1:8088/ari' },
    { RTP_PAYLOAD_TYPE: '8' }, { RTP_PAYLOAD_TYPE: '-1' }, { RTP_BIND_ADDRESS: '0.0.0.0' },
    { OPENAI_API_KEY: '' }, { ZADARMA_ENDPOINT: 'x/y' }]) assert.throws(() => loadConfig({ ...env, ...extra }));
});
test('phone format rejects SIP dial-string injection and accepts E.164', () => {
  assert.equal(validateNumber('+380991234567'), '+380991234567');
  for (const value of ['380991234567', '+3801@other', '+380/12345678', '+0123456789', '']) assert.throws(() => validateNumber(value));
});
test('Zadarma normalization removes leading plus only from the validated dial target', () => {
  const number = validateNumber('+380991234567');
  assert.equal(normalizeZadarmaNumber(number), '380991234567');
  assert.equal(number, '+380991234567');
});
test('CLI validation and normalization still reject numbers without plus and malformed international numbers', () => {
  for (const number of ['380991234567', '00380991234567', '++380991234567',
    '+38099+1234567', '+380991234567@220546', '+380 991234567', '+0123456789', '+380', '']) {
    assert.throws(() => validateNumber(number));
    assert.throws(() => normalizeZadarmaNumber(number));
  }
});
test('known secrets and Basic token redacted in error text', () => {
  const config = loadConfig(env);
  const token = Buffer.from('bridge:dummy-password').toString('base64');
  const message = safeMessage(new Error(`dummy-key dummy-password ${token} Bearer secret`), config);
  assert.equal(message.includes('dummy-key'), false); assert.equal(message.includes('dummy-password'), false);
  assert.equal(message.includes(token), false); assert.equal(message.includes('Bearer secret'), false);
});
