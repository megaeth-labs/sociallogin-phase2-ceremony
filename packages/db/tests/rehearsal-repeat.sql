\set ON_ERROR_STOP on
-- Isolated schema: exercise the migration's real PostgreSQL trigger and indexes.
CREATE TEMP TABLE ceremonies (id uuid PRIMARY KEY, manifest jsonb NOT NULL);
CREATE TEMP TABLE contributions (ceremony_id uuid NOT NULL, participant_id uuid NOT NULL);
CREATE UNIQUE INDEX contributions_one_per_participant ON contributions(ceremony_id, participant_id);
INSERT INTO ceremonies VALUES
 ('00000000-0000-4000-8000-000000000001','{"purpose":"rehearsal"}'),
 ('00000000-0000-4000-8000-000000000002','{"purpose":"production"}'),
 ('00000000-0000-4000-8000-000000000003','{}');
INSERT INTO contributions VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004');
\ir ../migrations/005_rehearsal_repeat_contributions.sql
INSERT INTO contributions(ceremony_id,participant_id) VALUES
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004'),
 ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000004'),
 ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000004'),
 ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004');
DO $$
DECLARE c uuid;
BEGIN
 IF (SELECT count(*) FROM contributions WHERE rehearsal_repeat) <> 2 THEN
   RAISE EXCEPTION 'Existing records were modified or repeats failed';
 END IF;
 FOREACH c IN ARRAY ARRAY['00000000-0000-4000-8000-000000000002'::uuid,'00000000-0000-4000-8000-000000000003'::uuid] LOOP
   BEGIN
     -- A caller cannot bypass production identity uniqueness using the flag.
     INSERT INTO contributions VALUES(c,'00000000-0000-4000-8000-000000000004',true);
     RAISE EXCEPTION 'Duplicate production identity accepted';
   EXCEPTION WHEN unique_violation THEN NULL;
   END;
 END LOOP;
END;
$$;
DROP FUNCTION set_contribution_rehearsal_policy() CASCADE;
