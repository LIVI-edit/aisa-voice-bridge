import { FRAME_BYTES, FRAME_MS } from './rtp.js';

export class AudioQueue {
  constructor(maxFrames = 100) {
    if (!Number.isInteger(maxFrames) || maxFrames < 1) throw new Error('Invalid queue limit.');
    this.limit = maxFrames * FRAME_BYTES;
    this.frames = [];
    this.pending = Buffer.alloc(0);
    this.closed = false;
  }
  get bytes() { return this.frames.length * FRAME_BYTES + this.pending.length; }
  push(chunk) {
    if (this.closed) return false;
    if (!Buffer.isBuffer(chunk)) throw new Error('Audio must be a Buffer.');
    // Check before allocation; overflow stops the call instead of growing memory.
    if (this.bytes + chunk.length > this.limit) throw new Error('Очередь голоса OpenAI переполнена (более 2 секунд).');
    const bytes = Buffer.concat([this.pending, chunk]);
    const complete = bytes.length - bytes.length % FRAME_BYTES;
    for (let i = 0; i < complete; i += FRAME_BYTES) {
      this.frames.push(Buffer.from(bytes.subarray(i, i + FRAME_BYTES)));
    }
    this.pending = Buffer.from(bytes.subarray(complete));
    return true;
  }
  take() { return this.frames.shift() || null; }
  // Live has no output-audio-done event. After an idle gap, pad a final tail
  // with PCMU silence; normally tails are joined to the next delta instead.
  flushPartial() {
    if (this.closed || !this.pending.length) return;
    const frame = Buffer.alloc(FRAME_BYTES, 0xff);
    this.pending.copy(frame);
    this.pending = Buffer.alloc(0);
    this.frames.push(frame);
  }
  close() {
    this.closed = true;
    this.frames.length = 0;
    this.pending = Buffer.alloc(0);
  }
}

// Recursive scheduling never sends a catch-up burst after an event-loop stall.
export class AudioPacer {
  constructor(queue, sendFrame, onError, timers = { setTimeout, clearTimeout, now: Date.now }) {
    Object.assign(this, { queue, sendFrame, onError, timers });
    this.active = false;
    this.lastPush = 0;
  }
  push(chunk) { this.queue.push(chunk); this.lastPush = this.timers.now(); }
  start() {
    if (this.active || this.queue.closed) return;
    this.active = true;
    this.schedule();
  }
  schedule() {
    this.timer = this.timers.setTimeout(() => {
      if (!this.active) return;
      try {
        if (!this.queue.frames.length && this.queue.pending.length &&
          this.timers.now() - this.lastPush >= 60) this.queue.flushPartial();
        // Continuous RTP also keeps timestamps and Asterisk's media path alive.
        this.sendFrame(this.queue.take() || Buffer.alloc(FRAME_BYTES, 0xff));
      } catch (error) { this.stop(); this.onError(error); return; }
      if (this.active) this.schedule();
    }, FRAME_MS);
  }
  stop() {
    this.active = false;
    this.timers.clearTimeout(this.timer);
    this.queue.close();
  }
}
