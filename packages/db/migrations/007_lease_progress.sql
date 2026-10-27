BEGIN;

-- Self-reported contributor progress, so a claimed slot whose download cannot
-- finish in time can be released early instead of holding the queue.
ALTER TABLE leases
  ADD COLUMN progress_stage text
    CHECK (progress_stage IN ('downloading','computing','uploading','other')),
  ADD COLUMN progress_fraction double precision
    CHECK (progress_fraction >= 0 AND progress_fraction <= 1),
  ADD COLUMN progress_advanced_at timestamptz,
  ADD COLUMN released_reason text
    CHECK (released_reason IN ('download-too-slow','download-stalled'));

COMMIT;
