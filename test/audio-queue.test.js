import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioQueue, AudioPacer } from '../src/audio-queue.js';

test('arbitrary delta split into 160-byte frames without changing bytes', () => {
  const queue = new AudioQueue(); const bytes = Buffer.from(Array.from({ length: 480 }, (_, i) => i % 256));
  queue.push(bytes);
  const frames = [queue.take(), queue.take(), queue.take()];
  assert.equal(frames.every((frame) => frame.length === 160), true);
  assert.deepEqual(Buffer.concat(frames), bytes); assert.equal(queue.take(), null);
});
test('partial frame carried into next delta', () => {
  const queue = new AudioQueue(); queue.push(Buffer.alloc(100, 1));
  assert.equal(queue.take(), null); assert.equal(queue.pending.length, 100);
  queue.push(Buffer.alloc(230, 2));
  assert.deepEqual(queue.take(), Buffer.concat([Buffer.alloc(100, 1), Buffer.alloc(60, 2)]));
  assert.deepEqual(queue.take(), Buffer.alloc(160, 2)); assert.equal(queue.pending.length, 10);
});
test('one-byte deltas reproduce continuous audio exactly', () => {
  const queue = new AudioQueue(); const bytes = Buffer.from(Array.from({ length: 320 }, (_, i) => i % 256));
  for (const value of bytes) queue.push(Buffer.from([value]));
  assert.deepEqual(Buffer.concat([queue.take(), queue.take()]), bytes);
});
test('overflow is bounded, atomic and does not allocate an unbounded queue', () => {
  const queue = new AudioQueue(2); queue.push(Buffer.alloc(200));
  assert.throws(() => queue.push(Buffer.alloc(121)), /переполнена/);
  assert.equal(queue.bytes, 200); queue.push(Buffer.alloc(120)); assert.equal(queue.bytes, 320);
});
test('cleanup clears full frames and tail; repeated cleanup/push safe', () => {
  const queue = new AudioQueue(); queue.push(Buffer.alloc(333)); queue.close(); queue.close();
  assert.equal(queue.bytes, 0); assert.equal(queue.take(), null);
  assert.equal(queue.push(Buffer.alloc(160)), false); assert.equal(queue.bytes, 0);
});
test('last partial frame padded with PCMU silence', () => {
  const queue = new AudioQueue(); queue.push(Buffer.alloc(7, 1)); queue.flushPartial();
  const frame = queue.take(); assert.equal(frame.length, 160);
  assert.deepEqual(frame.subarray(0, 7), Buffer.alloc(7, 1));
  assert.deepEqual(frame.subarray(7), Buffer.alloc(153, 0xff)); assert.equal(queue.bytes, 0);
});

function fakeTimers() {
  let now = 0; let id = 0; const tasks = new Map();
  return { now: () => now, setTimeout: (fn, ms) => { tasks.set(++id, { fn, ms }); return id; },
    clearTimeout: (key) => tasks.delete(key), tasks,
    step: (elapsed) => {
      now += elapsed;
      const [key, task] = tasks.entries().next().value;
      tasks.delete(key); assert.equal(task.ms, 20); task.fn();
    } };
}
test('pacer sends one frame per 20ms; a stalled timer never creates a catch-up burst', () => {
  const timers = fakeTimers(); const frames = []; const queue = new AudioQueue();
  const pacer = new AudioPacer(queue, (frame) => frames.push(frame), assert.fail, timers);
  pacer.push(Buffer.alloc(480, 1)); pacer.start(); pacer.start();
  assert.equal(timers.tasks.size, 1); assert.equal(frames.length, 0);
  timers.step(20); assert.equal(frames.length, 1);
  timers.step(200); assert.equal(frames.length, 2);
  timers.step(20); assert.equal(frames.length, 3);
  timers.step(20); assert.deepEqual(frames[3], Buffer.alloc(160, 0xff));
  pacer.stop(); pacer.stop(); assert.equal(timers.tasks.size, 0); assert.equal(queue.bytes, 0);
});
test('pacer preserves tail until 60ms idle; stop cancels even an already scheduled callback', () => {
  const timers = fakeTimers(); const frames = []; const queue = new AudioQueue();
  const pacer = new AudioPacer(queue, (frame) => frames.push(frame), assert.fail, timers);
  pacer.push(Buffer.alloc(7, 1)); pacer.start();
  timers.step(20); assert.equal(queue.pending.length, 7);
  timers.step(20); assert.equal(queue.pending.length, 7);
  timers.step(20); assert.equal(queue.pending.length, 0); assert.equal(frames[2][0], 1);
  const pendingCallback = timers.tasks.values().next().value.fn;
  pacer.stop(); pendingCallback(); assert.equal(frames.length, 3);
});
test('pacer error stops timer and clears remaining audio', () => {
  const timers = fakeTimers(); let failure; const queue = new AudioQueue();
  const pacer = new AudioPacer(queue, () => { throw new Error('send failed'); }, (error) => { failure = error; }, timers);
  pacer.push(Buffer.alloc(320)); pacer.start(); timers.step(20);
  assert.equal(failure.message, 'send failed'); assert.equal(timers.tasks.size, 0); assert.equal(queue.bytes, 0);
});
