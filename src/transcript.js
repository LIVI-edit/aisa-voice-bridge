import { createHash } from 'node:crypto';

const DNC = ['не телефонуйте мені', 'більше не дзвоніть', 'не звоните мне'];
const REJECT = ['не цікавить', 'не интересно'];

function norm(text) { return text.toLowerCase().replace(/[.,!?;:]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function mentionedRatherThanRequested(text, phrase) {
  const lower = text.toLowerCase(); const i = lower.lastIndexOf(phrase); if (i < 0) return false;
  const before = lower.slice(Math.max(0, i - 96), i); const after = lower.slice(i + phrase.length, i + phrase.length + 8);
  const openQuote = Math.max(before.lastIndexOf('«'), before.lastIndexOf('"'));
  const closeQuote = Math.max(before.lastIndexOf('»'), before.lastIndexOf('"', Math.max(0, openQuote - 1)));
  const quoted = openQuote > closeQuote || after.includes('»') || after.includes('"');
  const meta = /(?:не\s+)?(?:казав|говорив|говорила|говорил|сказал|сказала)|(?:фраза|слова|цитую|приклад|пример|якщо|если)\s*$/i.test(before.trim());
  return quoted || meta;
}
function detectGuard(text) {
  const n = norm(text);
  for (const p of DNC) if (n.includes(p) && !mentionedRatherThanRequested(text, p)) return 'dnc';
  for (const p of REJECT) if (n.includes(p) && !mentionedRatherThanRequested(text, p)) return 'rejection';
  return null;
}
export class TranscriptCollector {
  constructor(callId, { maxSegments = 1000, maxTextBytes = 262144, maxFragmentBytes = 8192 } = {}) {
    this.callId = callId; this.maxSegments = maxSegments; this.maxTextBytes = maxTextBytes; this.maxFragmentBytes = maxFragmentBytes;
    this.segments = []; this.ids = new Set(); this.bytes = 0; this.issues = new Set(); this.frozen = false; this.partial = false; this.userWindow = '';
  }
  add({ sessionId, eventId, speaker, startMs, endMs, delta, phase = 'active', receivedAt = new Date().toISOString() }) {
    if (this.frozen) return { accepted: false, reason: 'frozen' };
    if (!sessionId || !eventId || !['user','assistant'].includes(speaker) || !Number.isInteger(startMs) || !Number.isInteger(endMs) || startMs < 0 || endMs < startMs || typeof delta !== 'string' || !delta.length || Buffer.byteLength(delta) > this.maxFragmentBytes || !['pre_media','active','draining'].includes(phase)) {
      this.partial = true; this.issues.add('invalid_event'); return { accepted: false, reason: 'invalid_event', stop: true };
    }
    if (this.ids.has(eventId)) return { accepted: false, reason: 'duplicate' };
    const addBytes = Buffer.byteLength(delta);
    if (this.segments.length >= this.maxSegments || this.bytes + addBytes > this.maxTextBytes) { this.partial = true; this.issues.add('size_limit'); return { accepted: false, reason: 'size_limit', stop: true }; }
    const delivery = speaker === 'user' ? 'input_observed' : phase === 'pre_media' ? 'pre_media_dropped' : phase === 'draining' ? 'after_stop_unknown' : 'generated_playback_unknown';
    const segment = { call_id:this.callId, session_id:sessionId, event_id:eventId, speaker, start_ms:startMs, end_ms:endMs, arrival_seq:this.segments.length+1, received_at:receivedAt, delta, phase, delivery };
    this.segments.push(segment); this.ids.add(eventId); this.bytes += addBytes; if (speaker === 'assistant') this.issues.add('output_delivery_uncertain');
    let guard = null;
    if (speaker === 'user') { this.userWindow = (this.userWindow + delta).slice(-2048); const detected = detectGuard(this.userWindow); if (detected) guard = { type:detected, evidenceEventId:eventId }; }
    return { accepted: true, segment, guard };
  }
  markIssue(issue) { this.issues.add(issue); if (issue && issue !== 'output_delivery_uncertain') this.partial = true; }
  textFor(speaker) { return this.segments.filter((s)=>s.speaker===speaker).map((s)=>s.delta).join(''); }
  displayTimeline() { return [...this.segments].sort((a,b)=>a.start_ms-b.start_ms || a.end_ms-b.end_ms || a.arrival_seq-b.arrival_seq); }
  freeze({ notApplicable = false, unavailable = false } = {}) {
    this.frozen = true;
    const canonical = this.segments.map((s)=>JSON.stringify([s.session_id,s.event_id,s.speaker,s.start_ms,s.end_ms,s.arrival_seq,s.delta,s.phase,s.delivery])).join('\n');
    const sha256 = createHash('sha256').update(canonical).digest('hex');
    const state = notApplicable ? 'not_applicable' : unavailable || !this.segments.length ? 'unavailable' : this.partial ? 'partial' : 'captured';
    return { call_id:this.callId, state, completeness:'not_guaranteed', segment_count:this.segments.length, text_bytes:this.bytes, truncated:this.issues.has('size_limit'), issues:[...this.issues], sha256 };
  }
}
export function stopGuardWindow(text) { return detectGuard(text); }
