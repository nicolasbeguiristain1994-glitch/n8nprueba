-- Migration 073: Line ownership, user hierarchy, and line-sharing grants
--
-- Adds:
--   users.is_super_admin         BOOLEAN — unrestricted visibility across all operators
--   users.manager_id             UUID    — which admin manages this operator/viewer
--   users.created_by             UUID    — audit trail: who created this user
--   whatsapp_lines.owner_user_id UUID    — line owner (NULL = legacy/system line)
--   line_grants                  TABLE   — explicit sharing: admin grants operator access
--   get_accessible_line_ids()    FUNC    — centralised visibility logic for all consumers
--
-- Visibility rules enforced by get_accessible_line_ids(p_user_id):
--   super_admin       → all lines in the system
--   admin (not super) → own lines + their operators' lines + system lines (NULL owner)
--                       + lines explicitly granted to any of their operators
--   operator / viewer → own lines + lines with an explicit grant to them
--
-- Historical lines (owner_user_id = NULL): seeded or created before this migration.
--   Admins see them for compatibility; operators never see NULL-owner lines.
--
-- Idempotent: safe to run multiple times.

BEGIN;

-- ── 1. users: hierarchy columns ───────────────────────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manager_id     UUID    REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by     UUID    REFERENCES users(id) ON DELETE SET NULL;

-- Prevent a user from being their own manager
DO $$ BEGIN
  ALTER TABLE users
    ADD CONSTRAINT chk_users_no_self_manager
    CHECK (manager_id IS DISTINCT FROM id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- "All operators under admin X" — used heavily by get_accessible_line_ids
CREATE INDEX IF NOT EXISTS idx_users_manager    ON users(manager_id)    WHERE manager_id    IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_superadmin ON users(is_super_admin) WHERE is_super_admin = true;

-- ── 2. whatsapp_lines: ownership ──────────────────────────────────────────────

ALTER TABLE whatsapp_lines
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- NULL = legacy/system line — visible to all admins, never to operators.
-- Non-NULL = owned by a specific user; visibility controlled by the rules above.

CREATE INDEX IF NOT EXISTS idx_lines_owner ON whatsapp_lines(owner_user_id);

-- ── 3. line_grants: explicit sharing ─────────────────────────────────────────
-- An admin can grant one of their operators access to a line the operator doesn't own.
-- Only the line owner, their managing admin, or a super_admin can create/revoke grants.

CREATE TABLE IF NOT EXISTS line_grants (
  id         UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  line_id    UUID        NOT NULL REFERENCES whatsapp_lines(id) ON DELETE CASCADE,
  granted_to UUID        NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
  granted_by UUID        NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_line_grant UNIQUE (line_id, granted_to)
);

-- Cover the two query patterns: "all grantees for a line" and "all grants for an operator"
CREATE INDEX IF NOT EXISTS idx_line_grants_line_id    ON line_grants(line_id);
CREATE INDEX IF NOT EXISTS idx_line_grants_granted_to ON line_grants(granted_to);
CREATE INDEX IF NOT EXISTS idx_line_grants_granted_by ON line_grants(granted_by);

ALTER TABLE line_grants ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE  line_grants            IS 'Explicit line-sharing grants. Admin grants operator access to a line they do not own.';
COMMENT ON COLUMN line_grants.granted_to IS 'User who receives access to use this line for campaigns.';
COMMENT ON COLUMN line_grants.granted_by IS 'Admin/owner who authorised the grant. Auditable.';

-- ── 4. get_accessible_line_ids(p_user_id) ────────────────────────────────────
-- Single source of truth for line visibility across the entire platform.
--
-- Called by:
--   GET /api/lines                  (UI listing)
--   GET /api/lines/health           (health dashboard)
--   GET /api/stats/lines            (stats page)
--   campaign-distributor.ts         (line selection when campaign has owned_by)
--
-- NOT called by background jobs that operate on the global pool (no user context).

CREATE OR REPLACE FUNCTION get_accessible_line_ids(p_user_id UUID)
RETURNS SETOF UUID
LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE
  v_role     user_role;
  v_is_super BOOLEAN;
BEGIN
  SELECT role, is_super_admin
    INTO v_role, v_is_super
    FROM users
   WHERE id = p_user_id AND is_active = true;

  -- Fail-closed: inactive or unknown user → empty set (no lines visible)
  IF NOT FOUND THEN RETURN; END IF;

  -- Super admin: full unrestricted access
  IF v_is_super THEN
    RETURN QUERY SELECT id FROM whatsapp_lines;
    RETURN;
  END IF;

  -- Admin (non-super): own lines + operators' lines + legacy system lines + granted lines
  IF v_role = 'admin' THEN
    RETURN QUERY
      WITH my_operators AS (
        SELECT id FROM users
         WHERE manager_id = p_user_id
           AND is_active  = true
      )
      SELECT DISTINCT wl.id
        FROM whatsapp_lines wl
       WHERE wl.owner_user_id = p_user_id                      -- admin's own lines
          OR wl.owner_user_id IN (SELECT id FROM my_operators) -- operators' lines
          OR wl.owner_user_id IS NULL                          -- legacy/system lines
          OR EXISTS (                                          -- grants to their operators
               SELECT 1
                 FROM line_grants lg
                WHERE lg.line_id    = wl.id
                  AND lg.granted_to IN (SELECT id FROM my_operators)
             );
    RETURN;
  END IF;

  -- Operator / Viewer: own lines + explicit grants received
  RETURN QUERY
    SELECT DISTINCT wl.id
      FROM whatsapp_lines wl
     WHERE wl.owner_user_id = p_user_id
        OR EXISTS (
             SELECT 1
               FROM line_grants lg
              WHERE lg.line_id    = wl.id
                AND lg.granted_to = p_user_id
           );
END;
$$;

COMMENT ON FUNCTION get_accessible_line_ids IS
  'Returns line IDs visible/usable by a user. super_admin→all; admin→own+operators+system+granted; operator→own+granted. Fail-closed for inactive users.';

COMMIT;
