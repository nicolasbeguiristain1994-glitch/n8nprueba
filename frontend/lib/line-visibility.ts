/**
 * line-visibility.ts
 *
 * Single TypeScript interface over the get_accessible_line_ids() SQL function.
 * All line-visibility decisions go through this module — never inline SQL.
 *
 * Three public exports:
 *   getAccessibleLineIds()       — what lines a user can see/use (UI layer)
 *   lineVisibilityClause()       — SQL AND fragment for UI queries
 *   distributorVisibilityClause() — SQL AND fragment for campaign distributor
 *   canManageLineGrant()          — authorization gate for grant CRUD
 */

import { query } from '@/lib/db'
import type { SessionUser } from '@/lib/auth'

// ── Types ─────────────────────────────────────────────────────────────────────

export type VisibilityActor = Pick<SessionUser, 'user_id' | 'role' | 'is_super_admin'>

// ── getAccessibleLineIds ──────────────────────────────────────────────────────

/**
 * Returns the set of line IDs a user can see and use.
 *
 * Returns null for super_admins — they see all lines, so callers should skip
 * the WHERE filter entirely rather than fetching thousands of UUIDs.
 *
 * Returns [] if the user has no accessible lines (fail-closed).
 */
export async function getAccessibleLineIds(
  user: VisibilityActor,
): Promise<string[] | null> {
  if (user.is_super_admin) return null

  const rows = await query<{ id: string }>(
    `SELECT id FROM get_accessible_line_ids($1) AS t(id)`,
    [user.user_id],
  )
  return rows.map(r => r.id)
}

// ── lineVisibilityClause ──────────────────────────────────────────────────────

/**
 * Builds the SQL AND fragment to scope a whatsapp_lines query by visibility.
 * Designed to be appended after an existing WHERE clause.
 *
 * @param ids     - result of getAccessibleLineIds(). null = super_admin, no filter needed
 * @param alias   - SQL table alias (e.g. 'l', 'wl'). Pass '' for no alias.
 * @param startAt - $N index for the first new bind parameter
 *
 * @example
 *   const ids = await getAccessibleLineIds(user)
 *   const { clause, params } = lineVisibilityClause(ids, 'l', 2)
 *   await query(
 *     `SELECT * FROM whatsapp_lines l WHERE l.status = $1 ${clause} ORDER BY l.priority`,
 *     ['active', ...params],
 *   )
 */
export function lineVisibilityClause(
  ids:     string[] | null,
  alias:   string = '',
  startAt: number = 1,
): { clause: string; params: unknown[] } {
  if (ids === null) return { clause: '', params: [] }
  const col = alias ? `${alias}.id` : 'id'
  // ANY('{}') matches nothing — correct fail-closed behaviour for empty arrays
  return {
    clause: `AND ${col} = ANY($${startAt}::uuid[])`,
    params: [ids],
  }
}

// ── distributorVisibilityClause ───────────────────────────────────────────────

/**
 * Builds the SQL AND fragment to scope a whatsapp_lines query inside the
 * campaign distributor. Unlike the UI layer, this operates inline in SQL
 * (no pre-fetch of IDs) to avoid N+1 queries in the hot send loop.
 *
 * When operatorId is null/undefined (system campaigns, bootstrap, background jobs),
 * returns an empty clause — the distributor uses the full global pool.
 *
 * @param operatorId - campaign.owned_by (null = no restriction)
 * @param startAt    - $N index for the bind parameter
 * @param tableAlias - SQL table alias to qualify the id column (e.g. 'wl' when JOIN is present)
 */
export function distributorVisibilityClause(
  operatorId: string | null | undefined,
  startAt:    number = 1,
  tableAlias: string = '',
): { clause: string; params: unknown[] } {
  if (!operatorId) return { clause: '', params: [] }
  const col = tableAlias ? `${tableAlias}.id` : 'id'
  return {
    clause: `AND ${col} = ANY(get_accessible_line_ids($${startAt}::uuid))`,
    params: [operatorId],
  }
}

// ── canManageLineGrant ────────────────────────────────────────────────────────

/**
 * Authorization gate: can `actorId` create or revoke grants on `lineId`?
 *
 * Allowed when the actor is:
 *   - a super_admin, OR
 *   - the direct owner of the line (owner_user_id = actorId), OR
 *   - an admin who is the manager of the line's owner (owner_u.manager_id = actorId)
 *
 * Returns false if the line does not exist or the actor is not found.
 */
export async function canManageLineGrant(
  actorId: string,
  lineId:  string,
): Promise<boolean> {
  const rows = await query<{ allowed: boolean }>(`
    SELECT EXISTS (
      SELECT 1
        FROM users u
        JOIN whatsapp_lines wl ON wl.id = $2
       WHERE u.id = $1
         AND (
           u.is_super_admin = true
           OR wl.owner_user_id = $1
           OR (
             u.role = 'admin'
             AND wl.owner_user_id IS NOT NULL
             AND EXISTS (
               SELECT 1
                 FROM users owner_u
                WHERE owner_u.id         = wl.owner_user_id
                  AND owner_u.manager_id = $1
             )
           )
         )
    ) AS allowed
  `, [actorId, lineId])
  return rows[0]?.allowed ?? false
}
