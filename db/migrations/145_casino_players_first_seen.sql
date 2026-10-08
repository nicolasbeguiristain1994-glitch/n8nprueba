SET LOCAL lock_timeout = '5s';

-- Leave historical rows unknown: a deployment is not a registration date.
ALTER TABLE casino_players ADD COLUMN IF NOT EXISTS first_seen_at timestamptz;
ALTER TABLE casino_players ALTER COLUMN first_seen_at SET DEFAULT now();
COMMENT ON COLUMN casino_players.first_seen_at IS
  'First insertion into the local player registry, not platform registration. Historical rows stay NULL.';
