-- The sealing instant is signed in the manifest, but every comparison against
-- it is made by the coordinator's own PostgreSQL clock. An operator with host
-- or NTP control could therefore step that clock back after sealsAt and keep
-- accepting contributions, and every resulting receipt, transcript event and
-- checkpoint would still verify, because nothing in the signed evidence chain
-- is anchored to attested time.
--
-- Record the furthest point in time this ceremony has ever observed. It only
-- moves forward, so once the coordinator has seen any instant at or past
-- sealsAt — which it must, in order to seal — an acceptance that requires the
-- clock to be before sealsAt can no longer be satisfied. Rolling the clock back
-- stops the ceremony rather than reopening it.
--
-- This narrows the attack; it does not remove it. Nothing here is externally
-- attested, so an operator who rolls the clock back BEFORE ever observing
-- sealsAt is still unconstrained. The independent transcript witness remains
-- the real fix.
ALTER TABLE ceremonies
  ADD COLUMN observed_time_high_water timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN ceremonies.observed_time_high_water IS
  'Monotonic high-water mark of observed time. Never moves backwards. Guards the sealing instant against a coordinator clock rollback.';
