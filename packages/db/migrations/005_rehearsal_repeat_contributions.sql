BEGIN;

-- Existing immutable records stay untouched. Only new rehearsal records are
-- exempt from identity uniqueness; each still has a unique generation/submission.
ALTER TABLE contributions ADD COLUMN rehearsal_repeat boolean NOT NULL DEFAULT false;

CREATE FUNCTION set_contribution_rehearsal_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Never trust an INSERT's value for this field. The stored signed manifest
  -- determines the policy, including for writes outside queue admission.
  SELECT COALESCE(manifest->>'purpose' = 'rehearsal', false)
    INTO NEW.rehearsal_repeat FROM ceremonies WHERE id = NEW.ceremony_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER contributions_rehearsal_policy BEFORE INSERT ON contributions
  FOR EACH ROW EXECUTE FUNCTION set_contribution_rehearsal_policy();

DROP INDEX contributions_one_per_participant;
CREATE UNIQUE INDEX contributions_one_per_participant
  ON contributions(ceremony_id, participant_id) WHERE NOT rehearsal_repeat;

COMMIT;
