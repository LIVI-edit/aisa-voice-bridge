export const E164_RE = /^\+[1-9]\d{7,14}$/;
export const ENDPOINT_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function validateE164(value, label = 'phone') {
  if (typeof value !== 'string' || !E164_RE.test(value)) throw new Error(`${label}: expected strict E.164 (+...).`);
  return value;
}

export function validateEndpointAlias(value) {
  if (typeof value !== 'string' || !ENDPOINT_RE.test(value)) throw new Error('ASTERISK_OUTBOUND_ENDPOINT is missing or invalid.');
  return value;
}

export function validateDialNumberFormat(value) {
  if (!['e164', 'international_digits'].includes(value)) throw new Error('DIAL_NUMBER_FORMAT must be e164 or international_digits.');
  return value;
}

export function buildDialRoute(phoneE164, { endpointAlias, dialNumberFormat, outboundCallerId }) {
  const phone = validateE164(phoneE164, 'stored phone');
  const alias = validateEndpointAlias(endpointAlias);
  const mode = validateDialNumberFormat(dialNumberFormat);
  const callerId = validateE164(outboundCallerId, 'OUTBOUND_CALLER_ID');
  const dialNumber = mode === 'international_digits' ? phone.slice(1) : phone;
  return { endpoint: `PJSIP/${dialNumber}@${alias}`, dialNumber, callerId, targetE164: phone };
}
