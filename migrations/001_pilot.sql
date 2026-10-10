PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  company_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  name TEXT NOT NULL,
  context TEXT NOT NULL,
  source_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  contact_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  company_id TEXT NOT NULL REFERENCES companies(company_id),
  person_name TEXT,
  role_title TEXT,
  phone_e164 TEXT NOT NULL,
  language_preference TEXT NOT NULL CHECK (language_preference IN ('uk','ru','unknown')),
  context TEXT NOT NULL,
  phone_source_json TEXT NOT NULL,
  context_source_json TEXT NOT NULL,
  permission_state TEXT NOT NULL CHECK (permission_state IN ('unreviewed','approved','blocked')),
  authorization_id TEXT,
  dnc_state TEXT NOT NULL CHECK (dnc_state IN ('clear','hold','confirmed')),
  dnc_reason TEXT,
  last_call_id TEXT,
  last_attempt_at TEXT,
  next_action_json TEXT,
  review_pending INTEGER NOT NULL DEFAULT 0 CHECK (review_pending IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_phone_unique ON contacts(phone_e164);

CREATE TABLE IF NOT EXISTS authorizations (
  authorization_id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(contact_id),
  phone_e164 TEXT NOT NULL,
  contact_revision INTEGER NOT NULL,
  company_revision INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  basis TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  authorized_at TEXT NOT NULL,
  expires_at TEXT,
  actor_json TEXT NOT NULL,
  revoked_at TEXT,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(contact_id),
  company_id TEXT NOT NULL REFERENCES companies(company_id),
  authorization_id TEXT REFERENCES authorizations(authorization_id),
  actor_json TEXT NOT NULL,
  contact_revision INTEGER NOT NULL,
  company_revision INTEGER NOT NULL,
  target_e164 TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  prompt_snapshot_json TEXT NOT NULL,
  config_snapshot_json TEXT NOT NULL,
  context_snapshot_json TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT,
  originate_intent_at TEXT UNIQUE,
  originate_dispatched_at TEXT,
  answered_at TEXT,
  media_ready_at TEXT,
  end_observed_at TEXT,
  finalized_at TEXT,
  ari_app TEXT NOT NULL UNIQUE,
  phone_channel_id TEXT NOT NULL UNIQUE,
  media_channel_id TEXT NOT NULL UNIQUE,
  bridge_id TEXT NOT NULL UNIQUE,
  openai_session_id TEXT,
  telephony_outcome TEXT NOT NULL,
  termination_reason TEXT NOT NULL,
  ari_cause INTEGER,
  dialstatus TEXT,
  talk_duration_ms INTEGER,
  total_duration_ms INTEGER,
  processing_status TEXT NOT NULL,
  cleanup_state_json TEXT NOT NULL,
  openai_finalization TEXT NOT NULL,
  latest_usage_seconds REAL,
  final_usage_seconds REAL,
  transcript_state TEXT NOT NULL,
  transcript_envelope_json TEXT NOT NULL,
  audio_stats_json TEXT NOT NULL,
  review_required INTEGER NOT NULL CHECK(review_required IN (0,1)),
  start_error_code TEXT,
  scenario_id TEXT NOT NULL,
  scenario_version TEXT NOT NULL,
  scenario_variant_label TEXT,
  scenario_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_contact_idx ON calls(contact_id, prepared_at);
CREATE INDEX IF NOT EXISTS calls_target_idx ON calls(target_e164, prepared_at);
CREATE UNIQUE INDEX IF NOT EXISTS one_running_extraction_per_call ON calls(call_id) WHERE state <> 'terminal';

CREATE TABLE IF NOT EXISTS call_events (
  call_id TEXT NOT NULL REFERENCES calls(call_id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL,
  source_event_id TEXT,
  channel_id TEXT,
  cause INTEGER,
  dialstatus TEXT,
  error_code TEXT,
  PRIMARY KEY(call_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS call_event_source_unique ON call_events(call_id, source_event_id) WHERE source_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS transcript_segments (
  call_id TEXT NOT NULL REFERENCES calls(call_id),
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  speaker TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  arrival_seq INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  delta TEXT NOT NULL,
  phase TEXT NOT NULL,
  delivery TEXT NOT NULL,
  PRIMARY KEY(call_id, event_id),
  UNIQUE(call_id, arrival_seq)
);

CREATE TABLE IF NOT EXISTS post_call_results (
  result_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES calls(call_id),
  contact_id TEXT NOT NULL REFERENCES contacts(contact_id),
  company_id TEXT NOT NULL REFERENCES companies(company_id),
  transcript_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  extractor_model TEXT NOT NULL,
  extractor_prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  semantic_json TEXT,
  needs_review INTEGER NOT NULL CHECK(needs_review IN (0,1)),
  review_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_running_result_per_call ON post_call_results(call_id) WHERE status='running';

CREATE TABLE IF NOT EXISTS reviews (
  review_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES calls(call_id),
  result_id TEXT REFERENCES post_call_results(result_id),
  expected_contact_revision INTEGER NOT NULL,
  actor_json TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  decision TEXT NOT NULL,
  dnc_action TEXT NOT NULL,
  corrected_semantic_json TEXT,
  accepted_next_action_json TEXT,
  contact_updates_json TEXT NOT NULL,
  notes TEXT NOT NULL,
  evidence_event_ids_json TEXT NOT NULL,
  applied INTEGER NOT NULL CHECK(applied IN (0,1))
);

CREATE TABLE IF NOT EXISTS runtime_lock (
  scope TEXT PRIMARY KEY CHECK(scope='voice_pilot'),
  call_id TEXT NOT NULL REFERENCES calls(call_id),
  pid INTEGER NOT NULL,
  boot_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);
