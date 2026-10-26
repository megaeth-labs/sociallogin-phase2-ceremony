CREATE TABLE ceremony_publications (
  ceremony_id uuid NOT NULL REFERENCES ceremonies(id),
  event_sequence bigint NOT NULL CHECK (event_sequence >= 0),
  event_hash char(64) NOT NULL CHECK (event_hash ~ '^[a-f0-9]{64}$'),
  bundle_sha256 char(64) NOT NULL CHECK (bundle_sha256 ~ '^[a-f0-9]{64}$'),
  acknowledgement jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ceremony_id, event_sequence)
);
CREATE TRIGGER ceremony_publications_immutable BEFORE UPDATE OR DELETE ON ceremony_publications
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
