BEGIN;

CREATE TABLE operational_updates (
  ceremony_id uuid NOT NULL REFERENCES ceremonies(id),
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 256),
  update_sha256 char(64) NOT NULL CHECK (update_sha256 ~ '^[a-f0-9]{64}$'),
  envelope jsonb NOT NULL,
  archive_pin jsonb,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (ceremony_id, sequence),
  UNIQUE (ceremony_id, update_sha256)
);
CREATE TRIGGER operational_updates_immutable BEFORE UPDATE OR DELETE ON operational_updates
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
ALTER TABLE leases ADD COLUMN heartbeat_grace_seconds integer
  CHECK (heartbeat_grace_seconds > 0);

COMMIT;
