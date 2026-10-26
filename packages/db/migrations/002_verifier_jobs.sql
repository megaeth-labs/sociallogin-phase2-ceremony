BEGIN;

CREATE TABLE verification_jobs (
  job_id uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES submissions(id),
  operator_key_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('CLAIMED','REPORTED','EXPIRED')),
  attempt integer NOT NULL CHECK (attempt > 0),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz NOT NULL,
  reported_at timestamptz,
  UNIQUE (submission_id, operator_key_id)
);

CREATE INDEX verification_jobs_claims
  ON verification_jobs(operator_key_id, lease_until)
  WHERE state = 'CLAIMED';

CREATE UNIQUE INDEX contributions_one_per_participant
  ON contributions(ceremony_id, participant_id);

COMMIT;
