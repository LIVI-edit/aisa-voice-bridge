import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contractsSchema, validatorEngine, getSchema, validateDefinition,
  validatePostCallSemantics, crossValidatePostCallSemantics,
} from '../src/contracts.js';

const timestamp = '2026-10-09T00:00:00.000Z';
const uuid = '00000000-0000-4000-8000-000000000001';
const source = () => ({
  kind: 'owner_supplied', reference: 'owner-reviewed record',
  captured_at: timestamp, supplied_by: 'owner',
});
const company = () => ({
  company_id: uuid, revision: 1, name: 'Example retailer', context: '',
  source: source(), created_at: timestamp, updated_at: timestamp,
});
const contact = () => ({
  contact_id: uuid, revision: 1, company_id: uuid,
  person_name: null, role_title: null, phone_e164: '+380501234567',
  language_preference: 'uk', context: '', phone_source: source(),
  context_source: source(), permission_state: 'unreviewed',
  authorization_id: null, dnc_state: 'clear', last_call_id: null,
  last_attempt_at: null,
  next_action: { kind: 'callback', note: 'Review first', due_text: null, due_at: null, review_id: uuid },
  created_at: timestamp, updated_at: timestamp,
});
const semantics = () => ({
  role_match: { value: 'unknown', evidence_event_ids: [] },
  interest: { value: 'unknown', evidence_event_ids: [] },
  rejection: { value: null, evidence_event_ids: [] },
  do_not_call: { value: null, evidence_event_ids: [] },
  next_step: { kind: 'none', status: 'none', details: null, evidence_event_ids: [] },
  callback: { requested: null, when_text: null, timezone_text: null, evidence_event_ids: [] },
  referral: { person_text: null, role_text: null, phone_text: null, contact_channel_text: null, evidence_event_ids: [] },
  questions_for_human: [], commitments: [],
  summary: { text: 'No verified user response.', evidence_event_ids: [] },
  confidence: 'low', needs_review: true, review_flags: [],
});

test('Ajv is the real validator and all root definitions compile on module import', () => {
  assert.equal(validatorEngine, 'ajv');
  assert.ok(contractsSchema.$id);
  assert.equal(Object.keys(contractsSchema.definitions).length, 18);
  for (const name of Object.keys(contractsSchema.definitions)) {
    assert.deepEqual(getSchema(name), contractsSchema.definitions[name]);
  }
  assert.throws(() => validateDefinition('NotADefinition', {}), /Unknown contract definition/);
});

test('root-relative #/definitions/Source resolves in Company without relaxing validation', () => {
  const valid = company();
  const validated = validateDefinition('Company', valid);
  assert.deepEqual(validated, valid);
  assert.notStrictEqual(validated, valid);
  assert.notStrictEqual(validated.source, valid.source);
  assert.throws(() => validateDefinition('Company', { ...valid, unexpected: true }), /schema validation failed/);
  assert.throws(() => validateDefinition('Company', { ...valid, source: { ...source(), injected: 'no' } }), /schema validation failed/);
  assert.throws(() => validateDefinition('Company', { ...valid, source: { ...source(), kind: 'fabricated' } }), /schema validation failed/);
  assert.throws(() => validateDefinition('Company', { ...valid, source: { ...source(), captured_at: 'not-a-date' } }), /schema validation failed/);
  const missing = company(); delete missing.source.reference;
  assert.throws(() => validateDefinition('Company', missing), /schema validation failed/);
});

test('multiple nested references (Source and NextAction) remain strict; no coercion or stripping', () => {
  const valid = contact();
  assert.deepEqual(validateDefinition('Contact', valid), valid);
  assert.throws(() => validateDefinition('Contact', { ...valid, revision: '1' }), /schema validation failed/);
  assert.throws(() => validateDefinition('Contact', { ...valid, phone_source: { ...source(), extra: false } }), /schema validation failed/);
  assert.throws(() => validateDefinition('Contact', { ...valid, next_action: { ...valid.next_action, extra: 1 } }), /schema validation failed/);
  assert.throws(() => validateDefinition('Contact', { ...valid, next_action: { ...valid.next_action, kind: 'silently_dial' } }), /schema validation failed/);
  assert.throws(() => validateDefinition('Contact', { ...valid, next_action: { ...valid.next_action, note: null } }), /schema validation failed/);
});

test('independent post-call schema still validates strictly and evidence cross-validation is unchanged', () => {
  const valid = semantics();
  assert.deepEqual(validatePostCallSemantics(valid), valid);
  assert.deepEqual(crossValidatePostCallSemantics(valid, []), valid);
  assert.deepEqual(getSchema('PostCallSemantics'), contractsSchema.definitions.PostCallSemantics);
  assert.notDeepEqual(getSchema('PostCallSemantics'), getSchema('PostCallResult'));
  assert.throws(() => validatePostCallSemantics({ ...valid, extra: 'not allowed' }), /schema validation failed/);
  assert.throws(() => validatePostCallSemantics({ ...valid, role_match: { ...valid.role_match, extra: 1 } }), /schema validation failed/);
  assert.throws(() => validatePostCallSemantics({ ...valid, confidence: 'invented' }), /schema validation failed/);
  assert.throws(() => validatePostCallSemantics({ ...valid, needs_review: 'true' }), /schema validation failed/);
  const missing = semantics(); delete missing.summary;
  assert.throws(() => validatePostCallSemantics(missing), /schema validation failed/);
  const withEvidence = semantics(); withEvidence.interest = { value: 'interested', evidence_event_ids: ['cross-call'] };
  assert.throws(() => crossValidatePostCallSemantics(withEvidence, []), /unknown\/cross-call evidence/);
});
