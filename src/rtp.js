import { randomBytes } from 'node:crypto';

export const FRAME_BYTES = 160;
export const FRAME_MS = 20;

// RFC 3550: extensions have a 16-bit length in 32-bit words.
export function parseRtp(packet, allowedPayloadTypes = [0]) {
  if (!Buffer.isBuffer(packet) || packet.length < 12 || packet[0] >>> 6 !== 2) return null;
  const padding = !!(packet[0] & 0x20);
  const hasExtension = !!(packet[0] & 0x10);
  const count = packet[0] & 0x0f;
  const payloadType = packet[1] & 0x7f;
  if (!allowedPayloadTypes.includes(payloadType)) return null;
  let offset = 12 + count * 4;
  if (offset > packet.length) return null;
  const csrc = [];
  for (let i = 0; i < count; i++) csrc.push(packet.readUInt32BE(12 + i * 4));
  let extension = null;
  if (hasExtension) {
    if (offset + 4 > packet.length) return null;
    const profile = packet.readUInt16BE(offset);
    const length = packet.readUInt16BE(offset + 2) * 4;
    offset += 4;
    if (offset + length > packet.length) return null;
    extension = { profile, data: packet.subarray(offset, offset + length) };
    offset += length;
  }
  let end = packet.length;
  let paddingBytes = 0;
  if (padding) {
    paddingBytes = packet[packet.length - 1];
    if (!paddingBytes || paddingBytes > end - offset) return null;
    end -= paddingBytes;
  }
  if (end <= offset) return null;
  return {
    payload: packet.subarray(offset, end), payloadType,
    sequence: packet.readUInt16BE(2), timestamp: packet.readUInt32BE(4),
    ssrc: packet.readUInt32BE(8), marker: !!(packet[1] & 0x80),
    csrc, extension, paddingBytes, headerBytes: offset,
  };
}

export function buildRtp(payload, { sequence, timestamp, ssrc, payloadType = 0, marker = false }) {
  if (!Buffer.isBuffer(payload) || !payload.length || payload.length > 65507 - 12) {
    throw new Error('Invalid RTP payload.');
  }
  for (const [value, max] of [[sequence, 0xffff], [timestamp, 0xffffffff],
    [ssrc, 0xffffffff], [payloadType, 127]]) {
    if (!Number.isInteger(value) || value < 0 || value > max) throw new Error('Invalid RTP field.');
  }
  const packet = Buffer.allocUnsafe(12 + payload.length);
  packet[0] = 0x80;
  packet[1] = payloadType | (marker ? 0x80 : 0);
  packet.writeUInt16BE(sequence, 2);
  packet.writeUInt32BE(timestamp, 4);
  packet.writeUInt32BE(ssrc, 8);
  payload.copy(packet, 12);
  return packet;
}

export class RtpPacketizer {
  constructor({ payloadType = 0, sequence = randomBytes(2).readUInt16BE(),
    timestamp = randomBytes(4).readUInt32BE(), ssrc = randomBytes(4).readUInt32BE() } = {}) {
    Object.assign(this, { payloadType, sequence, timestamp, ssrc });
    this.first = true;
  }
  next(frame) {
    if (frame.length !== FRAME_BYTES) throw new Error('PCMU frame must be 160 bytes.');
    const packet = buildRtp(frame, { ...this, marker: this.first });
    this.first = false;
    this.sequence = (this.sequence + 1) & 0xffff;
    this.timestamp = (this.timestamp + FRAME_BYTES) >>> 0;
    return packet;
  }
}
