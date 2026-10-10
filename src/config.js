import { resolve } from 'node:path';
import { validateDialNumberFormat, validateE164, validateEndpointAlias } from './telephony-route.js';

export const DEFAULT_POST_CALL_MODEL = 'gpt-4o-mini-2024-07-18';
export const DEFAULT_ARI_URL = 'http://127.0.0.1:8088/ari';

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Expected boolean value, got ${value}.`);
}
function int(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid integer configuration value: ${value}.`);
  return n;
}
function localAriUrl(value = DEFAULT_ARI_URL) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid ASTERISK_ARI_URL.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '8088' ||
      url.pathname.replace(/\/$/, '') !== '/ari' || url.username || url.password || url.search || url.hash) {
    throw new Error('ARI must remain http://127.0.0.1:8088/ari.');
  }
  return url.href.replace(/\/$/, '');
}

export function loadConfig(env = process.env, { requireNetwork = false } = {}) {
  const bindAddress = env.RTP_BIND_ADDRESS || '127.0.0.1';
  if (bindAddress !== '127.0.0.1') throw new Error('RTP_BIND_ADDRESS must remain 127.0.0.1.');
  const payloadType = int(env.RTP_PAYLOAD_TYPE, 0, 0, 127);
  if (payloadType !== 0 && payloadType < 96) throw new Error('RTP_PAYLOAD_TYPE must be 0 or explicit dynamic PT 96-127.');
  const config = {
    dbPath: resolve(env.AISA_VOICE_DB_PATH || './data/aisa-voice.sqlite'),
    pilotPolicyPath: resolve(env.AISA_PILOT_POLICY_PATH || './config/pilot-policy.example.json'),
    ariUrl: localAriUrl(env.ASTERISK_ARI_URL || DEFAULT_ARI_URL),
    ariUser: env.ASTERISK_ARI_USER?.trim() || null,
    ariPassword: env.ASTERISK_ARI_PASSWORD?.trim() || null,
    apiKey: env.OPENAI_API_KEY?.trim() || null,
    endpointAlias: env.ASTERISK_OUTBOUND_ENDPOINT?.trim() || null,
    dialNumberFormat: env.DIAL_NUMBER_FORMAT?.trim() || 'e164',
    outboundCallerId: env.OUTBOUND_CALLER_ID?.trim() || null,
    telephonyApprovalRef: env.TELEPHONY_APPROVAL_REF?.trim() || null,
    productionCallingPolicyId: env.PRODUCTION_CALLING_POLICY_ID?.trim() || null,
    realCallsEnabled: bool(env.REAL_CALLS_ENABLED, false),
    bindAddress, payloadType,
    voice: env.OPENAI_VOICE?.trim() || null,
    liveModel: 'gpt-live-1',
    postCallModel: env.POST_CALL_MODEL?.trim() || DEFAULT_POST_CALL_MODEL,
    requestTimeoutMs: int(env.REQUEST_TIMEOUT_MS, 10000, 100, 60000),
    connectTimeoutMs: int(env.CONNECT_TIMEOUT_MS, 15000, 100, 60000),
    answerTimeoutSeconds: int(env.ANSWER_TIMEOUT_SECONDS, 45, 1, 120),
    startupTimeoutSeconds: int(env.STARTUP_TIMEOUT_SECONDS, 90, 1, 180),
    maxTalkSeconds: int(env.MAX_TALK_SECONDS, 300, 1, 1800),
    maxTotalSeconds: int(env.MAX_TOTAL_SECONDS, 360, 1, 1800),
    asteriskAbsoluteSeconds: int(env.ASTERISK_ABSOLUTE_SECONDS, 375, 1, 3600),
    mediaTransportTimeoutSeconds: int(env.MEDIA_TRANSPORT_TIMEOUT_SECONDS, 15, 1, 120),
    closeTimeoutMs: int(env.CLOSE_TIMEOUT_MS, 15000, 100, 60000),
    maxQueueFrames: int(env.MAX_QUEUE_FRAMES, 100, 1, 1000),
  };
  validateDialNumberFormat(config.dialNumberFormat);
  if (config.endpointAlias) validateEndpointAlias(config.endpointAlias);
  if (config.outboundCallerId) validateE164(config.outboundCallerId, 'OUTBOUND_CALLER_ID');
  if (requireNetwork) validateRuntimeConfig(config);
  return config;
}

export function validateRuntimeConfig(config) {
  if (!config.realCallsEnabled) throw new Error('Real calls are disabled. Set REAL_CALLS_ENABLED=true only after deployment acceptance.');
  if (!config.productionCallingPolicyId) throw new Error('Production calling policy is unresolved.');
  if (!config.telephonyApprovalRef) throw new Error('TELEPHONY_APPROVAL_REF is required for real calls.');
  validateEndpointAlias(config.endpointAlias);
  validateDialNumberFormat(config.dialNumberFormat);
  validateE164(config.outboundCallerId, 'OUTBOUND_CALLER_ID');
  for (const [name, value] of [['ASTERISK_ARI_USER', config.ariUser], ['ASTERISK_ARI_PASSWORD', config.ariPassword], ['OPENAI_API_KEY', config.apiKey]]) {
    if (!value) throw new Error(`${name} is required for real call start.`);
  }
  return config;
}

export function safeMessage(error, config = {}) {
  let message = String(error?.message || error || 'Unknown error');
  const basic = config.ariUser && config.ariPassword ? Buffer.from(`${config.ariUser}:${config.ariPassword}`).toString('base64') : null;
  for (const secret of [config.apiKey, config.ariPassword, basic]) if (secret) message = message.split(secret).join('[REDACTED]');
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/Basic\s+\S+/gi, 'Basic [REDACTED]')
    .replace(/\+[1-9]\d{7,14}/g, '[PHONE]')
    .slice(0, 600);
}
