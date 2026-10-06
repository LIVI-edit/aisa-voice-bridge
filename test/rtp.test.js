import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRtp, parseRtp, RtpPacketizer } from '../src/rtp.js';

const payload = Buffer.from(Array.from({ length: 160 }, (_, i) => i));
const fields = { sequence: 1234, timestamp: 8000, ssrc: 0xdeadbeef, marker: true };
const base = () => buildRtp(payload, fields);

test('RTP build → parse: PCMU bytes and all header fields preserved', () => {
  const result = parseRtp(base());
  assert.deepEqual(result.payload, payload);
  for (const [key, value] of Object.entries(fields)) assert.equal(result[key], value);
  assert.equal(result.payloadType, 0); assert.equal(result.headerBytes, 12);
});
test('sequence increases by one, timestamp by 160, SSRC stays stable', () => {
  const encoder = new RtpPacketizer(fields);
  const a = parseRtp(encoder.next(payload)); const b = parseRtp(encoder.next(payload));
  assert.equal(b.sequence, a.sequence + 1); assert.equal(b.timestamp, a.timestamp + 160);
  assert.equal(b.ssrc, a.ssrc); assert.equal(a.marker, true); assert.equal(b.marker, false);
});
test('sequence/timestamp wrap at unsigned 16/32-bit limits', () => {
  const encoder = new RtpPacketizer({ sequence: 65535, timestamp: 0xffffff80, ssrc: 42 });
  encoder.next(payload); const next = parseRtp(encoder.next(payload));
  assert.equal(next.sequence, 0); assert.equal(next.timestamp, 32);
});
test('CSRC parsing skips two 32-bit identifiers', () => {
  const original = base(); const ids = Buffer.alloc(8); ids.writeUInt32BE(12); ids.writeUInt32BE(34, 4);
  const packet = Buffer.concat([original.subarray(0, 12), ids, payload]); packet[0] |= 2;
  const result = parseRtp(packet);
  assert.deepEqual(result.csrc, [12, 34]); assert.equal(result.headerBytes, 20);
  assert.deepEqual(result.payload, payload);
});
test('extension parsing uses 32-bit word length, not bytes', () => {
  const extension = Buffer.from([0xbe, 0xde, 0, 2, 1, 2, 3, 4, 5, 6, 7, 8]);
  const packet = Buffer.concat([base().subarray(0, 12), extension, payload]); packet[0] |= 0x10;
  const result = parseRtp(packet);
  assert.equal(result.extension.profile, 0xbede);
  assert.deepEqual(result.extension.data, extension.subarray(4));
  assert.equal(result.headerBytes, 24); assert.deepEqual(result.payload, payload);
});
test('padding excluded from audio payload', () => {
  const packet = Buffer.concat([base(), Buffer.from([0, 0, 0, 4])]); packet[0] |= 0x20;
  assert.equal(parseRtp(packet).paddingBytes, 4); assert.deepEqual(parseRtp(packet).payload, payload);
});
test('CSRC + extension + padding can coexist', () => {
  const packet = Buffer.concat([base().subarray(0, 12), Buffer.from([0, 0, 0, 1]),
    Buffer.from([0x10, 0, 0, 1, 5, 6, 7, 8]), payload, Buffer.from([0, 2])]);
  packet[0] = 0xb1;
  const result = parseRtp(packet);
  assert.deepEqual(result.payload, payload); assert.equal(result.headerBytes, 24);
  assert.deepEqual(result.csrc, [1]); assert.equal(result.paddingBytes, 2);
});
test('explicit dynamic PT accepted only when configured', () => {
  const packet = buildRtp(payload, { ...fields, payloadType: 100 });
  assert.equal(parseRtp(packet), null); assert.equal(parseRtp(packet, [100]).payloadType, 100);
});
test('invalid RTP rejected: type, short header, wrong version, missing CSRC/extension', () => {
  for (const packet of [null, 'x', Buffer.alloc(11), Buffer.alloc(12), Buffer.from([0x82, ...Buffer.alloc(11)]),
    Buffer.from([0x90, ...Buffer.alloc(11)])]) assert.equal(parseRtp(packet), null);
});
test('invalid RTP rejected: extension overrun, zero/oversized padding, empty payload, wrong PT', () => {
  const extension = Buffer.concat([base().subarray(0, 12), Buffer.from([0, 0, 0xff, 0xff]), payload]);
  extension[0] |= 0x10;
  const zeroPad = base(); zeroPad[0] |= 0x20; zeroPad[zeroPad.length - 1] = 0;
  const overPad = base(); overPad[0] |= 0x20; overPad[overPad.length - 1] = 255;
  const pt = base(); pt[1] = 8;
  for (const packet of [extension, zeroPad, overPad, base().subarray(0, 12), pt]) assert.equal(parseRtp(packet), null);
});
test('packet builder rejects oversized payload and invalid fields', () => {
  assert.throws(() => buildRtp(Buffer.alloc(0), fields));
  assert.throws(() => buildRtp(Buffer.alloc(65500), fields));
  assert.throws(() => buildRtp(payload, { ...fields, sequence: -1 }));
  assert.throws(() => new RtpPacketizer(fields).next(Buffer.alloc(159)));
});
