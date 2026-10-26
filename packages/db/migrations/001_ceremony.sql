BEGIN;

CREATE TABLE ceremonies (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  state text NOT NULL CHECK (state IN ('DRAFT','PREPARING','PREPARED','OPEN','PAUSED','SEALED','WAITING_FOR_BEACON','FINALIZING','FINALIZED','CANCELLED','ABORTED')),
  manifest jsonb NOT NULL,
  manifest_sha256 char(64) NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  verifier_policy jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  head_generation bigint NOT NULL DEFAULT 0 CHECK (head_generation >= 0),
  head_sha256 char(64) NOT NULL CHECK (head_sha256 ~ '^[a-f0-9]{64}$'),
  head_byte_length bigint NOT NULL CHECK (head_byte_length > 0),
  event_sequence bigint NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
  event_hash char(64) NOT NULL CHECK (event_hash ~ '^[a-f0-9]{64}$'),
  opens_at timestamptz NOT NULL,
  seals_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (opens_at < seals_at)
);

CREATE TABLE participants (
  id uuid PRIMARY KEY,
  auth_subject_hash char(64) NOT NULL UNIQUE CHECK (auth_subject_hash ~ '^[a-f0-9]{64}$'),
  public_pseudonym text NOT NULL CHECK (length(public_pseudonym) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE queue_tickets (
  id uuid PRIMARY KEY,
  ceremony_id uuid NOT NULL REFERENCES ceremonies(id),
  participant_id uuid NOT NULL REFERENCES participants(id),
  status text NOT NULL CHECK (status IN ('QUEUED','OFFERED','LEASED','CANCELLED','EXPIRED','COMPLETED')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  offered_at timestamptz,
  completed_at timestamptz,
  UNIQUE (ceremony_id, participant_id, idempotency_key)
);

CREATE UNIQUE INDEX queue_one_live_ticket_per_participant
  ON queue_tickets(ceremony_id, participant_id)
  WHERE status IN ('QUEUED','OFFERED','LEASED');
CREATE INDEX queue_fifo ON queue_tickets(ceremony_id, enqueued_at, id) WHERE status = 'QUEUED';

CREATE TABLE leases (
  id uuid PRIMARY KEY,
  ceremony_id uuid NOT NULL REFERENCES ceremonies(id),
  ticket_id uuid NOT NULL UNIQUE REFERENCES queue_tickets(id),
  participant_id uuid NOT NULL REFERENCES participants(id),
  state text NOT NULL CHECK (state IN ('OFFERED','ACTIVE','SUBMITTED','VERIFYING','ACCEPTED','EXPIRED','REJECTED','STALE','CANCELLED')),
  base_generation bigint NOT NULL CHECK (base_generation >= 0),
  predecessor_sha256 char(64) NOT NULL CHECK (predecessor_sha256 ~ '^[a-f0-9]{64}$'),
  predecessor_byte_length bigint NOT NULL CHECK (predecessor_byte_length > 0),
  expected_contribution_name text NOT NULL CHECK (expected_contribution_name ~ '^[ -~]{1,64}$'),
  capability_hash char(64) NOT NULL UNIQUE CHECK (capability_hash ~ '^[a-f0-9]{64}$'),
  offered_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX leases_one_live_per_ceremony
  ON leases(ceremony_id)
  WHERE state IN ('OFFERED','ACTIVE','SUBMITTED','VERIFYING');
CREATE UNIQUE INDEX leases_one_live_per_participant
  ON leases(ceremony_id, participant_id)
  WHERE state IN ('OFFERED','ACTIVE','SUBMITTED','VERIFYING');

CREATE TABLE artifacts (
  sha256 char(64) PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  ceremony_id uuid NOT NULL REFERENCES ceremonies(id),
  kind text NOT NULL CHECK (kind IN ('GENESIS','CONTRIBUTION','BEACON','ORPHAN')),
  byte_length bigint NOT NULL CHECK (byte_length > 0),
  storage_backend text NOT NULL CHECK (storage_backend IN ('local','s3')),
  object_key text NOT NULL,
  storage_version_id text NOT NULL,
  immutable boolean NOT NULL,
  predecessor_sha256 char(64),
  generation bigint CHECK (generation >= 0),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_backend, object_key, storage_version_id),
  CHECK ((kind = 'GENESIS' AND generation = 0 AND predecessor_sha256 IS NULL)
      OR (kind <> 'GENESIS' AND generation IS NOT NULL AND predecessor_sha256 IS NOT NULL))
);

CREATE TABLE submissions (
  id uuid PRIMARY KEY,
  ceremony_id uuid NOT NULL REFERENCES ceremonies(id),
  lease_id uuid NOT NULL UNIQUE REFERENCES leases(id),
  participant_id uuid NOT NULL REFERENCES participants(id),
  state text NOT NULL CHECK (state IN ('SUBMITTED','VERIFYING','VERIFIED','ACCEPTED','REJECTED','STALE')),
  predecessor_sha256 char(64) NOT NULL CHECK (predecessor_sha256 ~ '^[a-f0-9]{64}$'),
  candidate_sha256 char(64) NOT NULL CHECK (candidate_sha256 ~ '^[a-f0-9]{64}$'),
  candidate_byte_length bigint NOT NULL CHECK (candidate_byte_length > 0),
  quarantine_object_key text NOT NULL,
  quarantine_version_id text NOT NULL,
  claimed_contribution_hash char(128) NOT NULL CHECK (claimed_contribution_hash ~ '^[a-f0-9]{128}$'),
  client_kind text NOT NULL CHECK (client_kind IN ('browser','cli','other')),
  client_release_sha256 char(64),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX submissions_verify_queue ON submissions(submitted_at, id) WHERE state IN ('SUBMITTED','VERIFYING');

CREATE TABLE artifact_uploads (
  id uuid PRIMARY KEY,
  ceremony_id uuid NOT NULL REFERENCES ceremonies(id),
  lease_id uuid NOT NULL UNIQUE REFERENCES leases(id),
  participant_id uuid NOT NULL REFERENCES participants(id),
  state text NOT NULL CHECK (state IN ('INITIATED','UPLOADING','COMPLETED','EXPIRED','REJECTED')),
  store_grant jsonb NOT NULL,
  max_byte_length bigint NOT NULL CHECK (max_byte_length > 0),
  artifact jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE verification_reports (
  id uuid PRIMARY KEY,
  ceremony_id uuid NOT NULL REFERENCES ceremonies(id),
  submission_id uuid NOT NULL REFERENCES submissions(id),
  operator_key_id text NOT NULL,
  job_id uuid NOT NULL,
  job_attempt integer NOT NULL CHECK (job_attempt > 0),
  pass_number integer NOT NULL CHECK (pass_number > 0),
  candidate_sha256 char(64) NOT NULL CHECK (candidate_sha256 ~ '^[a-f0-9]{64}$'),
  result text NOT NULL CHECK (result IN ('valid','invalid','error')),
  payload jsonb NOT NULL,
  signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, operator_key_id, job_id, job_attempt, pass_number)
);

CREATE TABLE transcript_events (
  ceremony_id uuid NOT NULL REFERENCES ceremonies(id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  previous_event_hash char(64) NOT NULL CHECK (previous_event_hash ~ '^[a-f0-9]{64}$'),
  event_hash char(64) NOT NULL CHECK (event_hash ~ '^[a-f0-9]{64}$'),
  event_type text NOT NULL CHECK (event_type ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  payload jsonb NOT NULL,
  signature text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (ceremony_id, sequence),
  UNIQUE (ceremony_id, event_hash)
);

CREATE TABLE contributions (
  ceremony_id uuid NOT NULL REFERENCES ceremonies(id),
  generation bigint NOT NULL CHECK (generation > 0),
  submission_id uuid NOT NULL UNIQUE REFERENCES submissions(id),
  participant_id uuid NOT NULL REFERENCES participants(id),
  predecessor_sha256 char(64) NOT NULL CHECK (predecessor_sha256 ~ '^[a-f0-9]{64}$'),
  successor_sha256 char(64) NOT NULL UNIQUE REFERENCES artifacts(sha256),
  contribution_hash char(128) NOT NULL CHECK (contribution_hash ~ '^[a-f0-9]{128}$'),
  contribution_name text NOT NULL,
  receipt jsonb NOT NULL,
  receipt_signature text NOT NULL,
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY (ceremony_id, generation)
);

CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished ON outbox(created_at, id) WHERE published_at IS NULL;

CREATE FUNCTION reject_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable ceremony record cannot be changed';
END;
$$;

CREATE TRIGGER transcript_events_immutable BEFORE UPDATE OR DELETE ON transcript_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER contributions_immutable BEFORE UPDATE OR DELETE ON contributions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

COMMIT;
