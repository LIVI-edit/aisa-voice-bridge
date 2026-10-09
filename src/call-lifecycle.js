export function classifyUnanswered({ dialstatus = null, cause = null } = {}) {
  const d = typeof dialstatus === 'string' ? dialstatus.toUpperCase() : null;
  if (d === 'BUSY' || cause === 17) return { telephonyOutcome: 'busy', terminationReason: 'carrier_busy' };
  if (d === 'NOANSWER' || cause === 18 || cause === 19) return { telephonyOutcome: 'no_answer', terminationReason: 'no_answer_timeout' };
  if (cause === 21) return { telephonyOutcome: 'rejected', terminationReason: 'carrier_rejected' };
  if (d === 'CHANUNAVAIL' || d === 'CONGESTION') return { telephonyOutcome: 'failed', terminationReason: 'ari_error' };
  return { telephonyOutcome: 'unknown_unanswered', terminationReason: 'unknown' };
}

export function applyLifecycleFact(state, fact) {
  const next = structuredClone(state);
  if (fact.kind === 'answered' && !next.answeredAt) {
    next.answeredAt = fact.at; next.telephonyOutcome = 'answered'; next.state = 'answered';
  } else if (fact.kind === 'media_ready' && next.answeredAt) next.mediaReadyAt = fact.at;
  else if (fact.kind === 'carrier_end') {
    next.endObservedAt ||= fact.at; next.ariCause ??= fact.cause ?? null; next.dialstatus ??= fact.dialstatus ?? null;
    if (!next.answeredAt) Object.assign(next, classifyUnanswered({ dialstatus: next.dialstatus, cause: next.ariCause }));
  } else if (fact.kind === 'fault') {
    next.processingStatus = 'failed'; next.terminationReason = fact.reason || next.terminationReason || 'unknown';
    if (next.answeredAt) next.telephonyOutcome = 'answered';
  }
  return next;
}

export function deadlinePlan(startedAtMs, answeredAtMs, config) {
  return {
    startupDeadlineMs: startedAtMs + config.startupTimeoutSeconds * 1000,
    totalDeadlineMs: startedAtMs + config.maxTotalSeconds * 1000,
    talkDeadlineMs: answeredAtMs == null ? null : answeredAtMs + config.maxTalkSeconds * 1000,
    asteriskAbsoluteSeconds: config.asteriskAbsoluteSeconds,
  };
}
