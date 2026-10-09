import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { CallSession } from './call-session.js';
import { AriClient } from './ari.js';
import { composePrompt, getScenario } from './prompt.js';
import { validateDefinition } from './contracts.js';
import { validateRuntimeConfig } from './config.js';
import { classifyUnanswered } from './call-lifecycle.js';
import { TranscriptCollector } from './transcript.js';
import { PostCallExtractor } from './post-call.js';

const EMPTY_AUDIO_STATS = Object.freeze({
  input_packets: 0, input_bytes: 0, output_packets: 0, output_non_silence_bytes: 0,
  pre_media_dropped_bytes: 0, queued_bytes_at_stop: 0, invalid_packets: 0,
  foreign_packets: 0, stale_packets: 0,
});
const ABSENT_CLEANUP = Object.freeze({ phone: 'absent', media: 'absent', bridge: 'absent' });

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}
export function sha256Json(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
export function actorFromOs() {
  let user = 'unknown';
  try { user = userInfo().username || 'unknown'; } catch {}
  return { uid: typeof process.getuid === 'function' ? process.getuid() : -1, user };
}
export function loadPilotPolicy(path) {
  const policy = JSON.parse(readFileSync(path, 'utf8'));
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Pilot policy must be an object.');
  if (typeof policy.policy_version !== 'string' || !policy.policy_version) throw new Error('Pilot policy version is required.');
  for (const k of ['allowed_authorization_basis_ids', 'test_authorization_basis_ids']) if (!Array.isArray(policy[k]) || policy[k].some((x) => typeof x !== 'string')) throw new Error(`Invalid ${k}.`);
  return policy;
}
export function validateDeploymentPolicy(config, policy) {
  if (!config?.realCallsEnabled) throw new Error('Real calls disabled by runtime configuration.');
  if (!policy?.real_calls_enabled) throw new Error('Production calling policy is not enabled.');
  if (!config.productionCallingPolicyId || policy.production_calling_policy_id !== config.productionCallingPolicyId) throw new Error('Production calling policy id is unresolved or mismatched.');
  if (!Array.isArray(policy.allowed_authorization_basis_ids) || policy.allowed_authorization_basis_ids.length === 0) throw new Error('No production authorization basis is enabled.');
  return true;
}
function configSnapshot(config, policy) {
  return validateDefinition('ConfigSnapshot', {
    endpoint_alias: config.endpointAlias,
    dial_number_format: config.dialNumberFormat,
    outbound_caller_id: config.outboundCallerId,
    telephony_approval_ref: config.telephonyApprovalRef,
    call_policy_version: config.productionCallingPolicyId || policy.policy_version,
    live_model: 'gpt-live-1', live_voice: config.voice,
    post_call_model: config.postCallModel,
    max_talk_seconds: config.maxTalkSeconds,
    max_total_seconds: config.maxTotalSeconds,
    asterisk_absolute_seconds: config.asteriskAbsoluteSeconds,
    real_calls_enabled: !!config.realCallsEnabled,
  });
}
function contextSnapshot(gate, reviewedHistory, scenario) {
  const { review_pending: _reviewPending, ...contractContact } = gate.contact;
  return validateDefinition('ContactContext', {
    contact: contractContact,
    company: gate.company,
    reviewed_history: reviewedHistory,
    objective_id: scenario.scenario_id,
    allowed_next_steps: scenario.allowed_next_steps,
  });
}
function manifestPayload(call) {
  return {
    call_id: call.call_id,
    contact_id: call.contact_id,
    company_id: call.company_id,
    authorization_id: call.authorization_id,
    contact_revision: call.contact_revision,
    company_revision: call.company_revision,
    target_e164: call.target_e164,
    ari_app: call.ari_app,
    phone_channel_id: call.phone_channel_id,
    media_channel_id: call.media_channel_id,
    bridge_id: call.bridge_id,
    prompt_snapshot: call.prompt_snapshot,
    config_snapshot: call.config_snapshot,
    context_snapshot: call.context_snapshot,
    scenario_id: call.scenario_id,
    scenario_version: call.scenario_version,
    scenario_variant_label: call.scenario_variant_label,
    scenario_hash: call.scenario_hash,
  };
}
export function computeManifestHash(call) { return sha256Json(manifestPayload(call)); }
function emptyTranscript(callId) {
  return new TranscriptCollector(callId).freeze({ notApplicable: true });
}
function resourceIds(callId) {
  const slug = callId.replaceAll('-', '');
  return { ari_app: `aisa_${slug}`, phone_channel_id: `aisa_phone_${slug}`, media_channel_id: `aisa_media_${slug}`, bridge_id: `aisa_bridge_${slug}` };
}

export function prepareCall({ store, config, policy, contactId, scenarioId, actor = actorFromOs(), now = () => new Date().toISOString() }) {
  const gate = store.gate(contactId, { policy, forReal: !!config.realCallsEnabled });
  if (!gate.allowed) throw Object.assign(new Error(`Call gate blocked: ${gate.reason}`), { code: gate.reason });
  const scenario = getScenario(scenarioId);
  const reviewedHistory = store.getReviewedHistory(contactId);
  const prompt = validateDefinition('PromptSnapshot', composePrompt({ contact: gate.contact, company: gate.company, reviewedHistory, scenarioId }));
  const context = contextSnapshot(gate, reviewedHistory, scenario);
  const cfg = configSnapshot(config, policy);
  const callId = randomUUID(); const preparedAt = now();
  const call = {
    call_id: callId, contact_id: gate.contact.contact_id, company_id: gate.company.company_id,
    authorization_id: gate.authorization.authorization_id, actor,
    contact_revision: gate.contact.revision, company_revision: gate.company.revision,
    target_e164: gate.contact.phone_e164, prepared_at: preparedAt,
    expires_at: new Date(Date.parse(preparedAt) + 15 * 60 * 1000).toISOString(),
    manifest_hash: '0'.repeat(64), prompt_snapshot: prompt, config_snapshot: cfg, context_snapshot: context,
    state: 'prepared', started_at: null, originate_intent_at: null, answered_at: null, media_ready_at: null,
    end_observed_at: null, finalized_at: null, ...resourceIds(callId), openai_session_id: null,
    telephony_outcome: 'not_attempted', termination_reason: 'unknown', ari_cause: null, dialstatus: null,
    talk_duration_ms: null, total_duration_ms: null, processing_status: 'ok', cleanup_state: { ...ABSENT_CLEANUP },
    openai_finalization: 'not_started', latest_usage_seconds: null, final_usage_seconds: null,
    transcript_state: 'not_applicable', transcript_envelope: emptyTranscript(callId), audio_stats: { ...EMPTY_AUDIO_STATS }, review_required: false,
    scenario_id: scenario.scenario_id, scenario_version: scenario.version, scenario_variant_label: scenario.variant_label,
    scenario_hash: prompt.sha256,
  };
  call.manifest_hash = computeManifestHash(call);
  validateDefinition('CallRecord', call);
  store.createCall(call); store.addEvent(callId, 'prepared', { source: 'operator' });
  return store.getCall(callId);
}

export function verifyPreparedCall({ store, config, policy, callId, confirmPhone, forReal = true }) {
  const call = store.getCall(callId); if (!call) throw new Error('Call not found.');
  if (call.state !== 'prepared' || call.originate_intent_at) throw Object.assign(new Error('Call is not startable; reprepare required.'), { code: 'call_not_prepared' });
  if (confirmPhone !== call.target_e164) throw Object.assign(new Error('Confirmed phone does not match stored prepared target.'), { code: 'phone_confirmation_mismatch' });
  const gate = store.gate(call.contact_id, { policy, forReal }); if (!gate.allowed) throw Object.assign(new Error(`Call gate blocked: ${gate.reason}`), { code: gate.reason });
  if (gate.contact.revision !== call.contact_revision || gate.company.revision !== call.company_revision || gate.authorization.authorization_id !== call.authorization_id || gate.contact.phone_e164 !== call.target_e164) throw Object.assign(new Error('Prepared contact/company/authorization snapshot drifted; reprepare required.'), { code: 'prepared_snapshot_drift' });
  const scenario = getScenario(call.scenario_id);
  if (scenario.version !== call.scenario_version || scenario.variant_label !== call.scenario_variant_label) throw Object.assign(new Error('Scenario version drifted; reprepare required.'), { code: 'prepared_scenario_drift' });
  const reviewedHistory = store.getReviewedHistory(call.contact_id);
  const prompt = validateDefinition('PromptSnapshot', composePrompt({ contact: gate.contact, company: gate.company, reviewedHistory, scenarioId: call.scenario_id }));
  const context = contextSnapshot(gate, reviewedHistory, scenario);
  const cfg = configSnapshot(config, policy);
  const recomputed = { ...call, prompt_snapshot: prompt, context_snapshot: context, config_snapshot: cfg, scenario_hash: prompt.sha256 };
  if (computeManifestHash(recomputed) !== call.manifest_hash) throw Object.assign(new Error('Prepared prompt/config/context hash drifted; reprepare required.'), { code: 'prepared_manifest_drift' });
  return call;
}

function persistFact(store, callId, fact) {
  if (fact.kind === 'answered') { store.updateCall(callId, { state: 'answered', answeredAt: fact.at }); store.addEvent(callId, 'answered', { source: 'ari' }); }
  else if (fact.kind === 'media_ready') { store.updateCall(callId, { mediaReadyAt: fact.at }); store.addEvent(callId, 'media_ready', { source: 'app' }); }
  else if (fact.kind === 'late_cause') store.updateCall(callId, { ariCause: fact.cause });
  else if (fact.kind === 'live_started') { store.updateCall(callId, { openaiSessionId: fact.sessionId }); store.addEvent(callId, 'live_started', { source: 'live' }); }
  else if (fact.kind === 'live_usage') store.updateCall(callId, { latestUsageSeconds: fact.seconds });
}

export async function startCall({ store, config, policy, callId, confirmPhone, sessionFactory = (cfg, call, deps) => new CallSession(cfg, call, deps), signalRegistrar = null }) {
  validateRuntimeConfig(config); validateDeploymentPolicy(config, policy);
  const prepared = verifyPreparedCall({ store, config, policy, callId, confirmPhone, forReal: true });
  const reserved = store.acquireStart(callId, { policy, forReal: true, expectedManifestHash: prepared.manifest_hash });
  const deps = {
    onFact: (fact) => persistFact(store, callId, fact),
    persistSegment: (segment) => store.addTranscriptSegment(segment),
    onProtectiveStop: ({ type, phone, evidenceEventId }) => {
      if (type === 'dnc') store.setProtectiveHoldByPhone(phone, `live_dnc:${evidenceEventId}`);
      store.addEvent(callId, 'policy_stop', { source: 'app', sourceEventId: evidenceEventId });
    },
    beforeOriginate: () => {
      const g = store.gate(reserved.contact_id, { policy, forReal: true });
      if (!g.allowed) throw Object.assign(new Error(`Gate changed immediately before originate: ${g.reason}`), { code: g.reason });
    },
    afterOriginate: () => store.markOriginateDispatched(callId),
  };
  const session = sessionFactory(config, reserved, deps);
  let removeSignals = () => {};
  if (signalRegistrar) removeSignals = signalRegistrar((name) => void session.cleanup('process_signal', new Error(`Process signal ${name}.`))) || removeSignals;
  let result;
  try { result = await session.run(); }
  catch (error) {
    result = { failed: true, telephonyOutcome: reserved.answered_at ? 'answered' : 'failed', terminationReason: 'unknown', cleanupState: { phone:'unknown', media:'unknown', bridge:'unknown' }, transcriptEnvelope: reserved.transcript_envelope, audioStats: reserved.audio_stats, openaiFinalization:'unconfirmed', latestUsageSeconds:null, finalUsageSeconds:null, answeredAt: reserved.answered_at, mediaReadyAt: reserved.media_ready_at, ariCause:null, dialstatus:null, error };
  } finally { removeSignals(); }
  const fresh = store.getCall(callId);
  const outcome = fresh.answered_at ? 'answered' : result.telephonyOutcome;
  const classified = !fresh.answered_at && ['carrier_end','unknown'].includes(result.terminationReason)
    ? classifyUnanswered({ dialstatus: result.dialstatus, cause: result.ariCause }) : null;
  const terminationReason = classified?.terminationReason || result.terminationReason;
  const final = store.finalizeCall(callId, {
    cleanupState: result.cleanupState,
    telephonyOutcome: outcome,
    terminationReason,
    processingStatus: result.failed ? 'failed' : 'ok',
    transcriptEnvelope: result.transcriptEnvelope,
    audioStats: result.audioStats,
    openaiFinalization: result.openaiFinalization,
    latestUsageSeconds: result.latestUsageSeconds,
    finalUsageSeconds: result.finalUsageSeconds,
    answeredAt: result.answeredAt,
    mediaReadyAt: result.mediaReadyAt,
    ariCause: result.ariCause,
    dialstatus: result.dialstatus,
  });
  return final;
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } }
export async function recoverCalls({ store, config, ariFactory = (cfg, app) => new AriClient(cfg, app), isPidAlive = pidAlive }) {
  const lock = store.getRuntimeLock();
  if (lock && lock.boot_id === store.bootId && isPidAlive(lock.pid)) return { recovered: 0, skipped_live_lock: true, pending: store.pendingRecovery().length };
  const pending = store.pendingRecovery(); const results = [];
  for (const row of pending) {
    const call = store.getCall(row.call_id); const ari = ariFactory(config, call.ari_app); const cleanup = { ...call.cleanup_state };
    let connected = false;
    try {
      await ari.connect(); connected = true;
      for (const [key, path] of [['phone', `/channels/${call.phone_channel_id}`], ['media', `/channels/${call.media_channel_id}`], ['bridge', `/bridges/${call.bridge_id}`]]) {
        if (cleanup[key] === 'absent' && !call.originate_intent_at && key === 'phone') continue;
        try { await ari.request('DELETE', path, {}, { ignoreMissing: true }); cleanup[key] = (await ari.exists(path)) ? 'unknown' : 'absent'; }
        catch { cleanup[key] = 'unknown'; }
      }
    } catch { cleanup.phone = cleanup.phone === 'absent' ? 'absent' : 'unknown'; cleanup.media = cleanup.media === 'absent' ? 'absent' : 'unknown'; cleanup.bridge = cleanup.bridge === 'absent' ? 'absent' : 'unknown'; }
    finally { if (connected) ari.close(); }
    const segments = store.getTranscript(call.call_id);
    const collector = new TranscriptCollector(call.call_id); for (const s of segments) collector.add({ sessionId:s.session_id,eventId:s.event_id,speaker:s.speaker,startMs:s.start_ms,endMs:s.end_ms,delta:s.delta,phase:s.phase,receivedAt:s.received_at });
    if (segments.length) collector.markIssue('transport_lost');
    const transcriptEnvelope = collector.freeze({ notApplicable: !call.answered_at, unavailable: !!call.answered_at && !segments.length });
    const classified = call.answered_at ? { telephonyOutcome:'answered', terminationReason:'process_interrupted' } : classifyUnanswered({ dialstatus:call.dialstatus,cause:call.ari_cause });
    const final = store.finalizeInterruptedRecovery(call.call_id,{ cleanupState:cleanup, telephonyOutcome:call.answered_at?'answered':classified.telephonyOutcome, transcriptEnvelope, audioStats:call.audio_stats, openaiFinalization:call.openai_finalization==='confirmed'?'confirmed':'unconfirmed' });
    if (Object.values(cleanup).includes('unknown')) { results.push({ call_id:call.call_id, cleanup, status:'hold_unknown_cleanup' }); continue; }
    results.push({ call_id:call.call_id, cleanup, status:'reconciled', final_state:final.state });
  }
  return { recovered: results.filter((x)=>x.status==='reconciled').length, results };
}

export async function extractCall({ store, config, callId, extractor = new PostCallExtractor(config) }) {
  const call = store.getCall(callId); if (!call) throw new Error('Call not found.');
  if (call.state !== 'terminal') throw new Error('Call must be terminal before extraction.');
  if (call.telephony_outcome !== 'answered') return { skipped: true, reason:'not_answered' };
  const segments = store.getTranscript(callId);
  const initial = { result_id: randomUUID(), call_id:call.call_id, contact_id:call.contact_id, company_id:call.company_id, transcript_sha256:call.transcript_envelope.sha256, created_at:new Date().toISOString(), extractor_model:config.postCallModel, extractor_prompt_version:'1', schema_version:'1', status:'running', error_code:null, semantic:null, needs_review:true, review_id:null };
  store.createResult(initial);
  let result;
  try { result = await extractor.extract({ call, segments }); }
  catch { store.updateResult(initial.result_id,{status:'interrupted',errorCode:'extractor_crash',semantic:null,needsReview:true}); return store.getResult(initial.result_id); }
  store.updateResult(initial.result_id,{ status:result.status, errorCode:result.error_code, semantic:result.semantic, needsReview:true });
  return store.getResult(initial.result_id);
}
