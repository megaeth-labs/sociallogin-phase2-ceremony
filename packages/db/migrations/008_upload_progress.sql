BEGIN;

-- When the current stage began, so an upload's rate is measured from the
-- start of the upload rather than from the claim.
ALTER TABLE leases ADD COLUMN progress_stage_started_at timestamptz;

ALTER TABLE leases DROP CONSTRAINT leases_released_reason_check;
ALTER TABLE leases ADD CONSTRAINT leases_released_reason_check
  CHECK (released_reason IN ('download-too-slow','download-stalled','upload-too-slow','upload-stalled'));

COMMIT;
