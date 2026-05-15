/**
 * /api/lines/grants
 *
 * CRUD for line-sharing grants. Allows an admin to give one of their operators
 * access to use a line that the operator does not own.
 *
 * Authorization rules (enforced strictly on every write):
 *   Only the following actors can create or revoke a grant:
 *     1. super_admin
 *     2. The line owner (owner_user_id = actor.user_id)
 *     3. An admin who is the manager of the line's owner (owner_u.manager_id = actor.user_id)
 *
 * Listing grants (GET):
 *   Returns all grants for a line. Requires lines:read and the line must be
 *   accessible to the requesting user.
 *
 * Creating a grant (POST):
 *   Body: { line_id, granted_to }
 *   granted_to must be an active operator or viewer under the actor's management.
 *
 * Revoking a grant (DELETE):
 *   Body: { line_id, granted_to }
 */

import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { parseBody, handleValidationError, GrantLineSchema, RevokeGrantSchema } from '@/lib/schema'
import { canManageLineGrant, getAccessibleLineIds } from '@/lib/line-visibility'

// ── GET /api/lines/grants?line_id=<uuid> ─────────────────────────────────────
// Returns all active grants for a line plus the grantee's basic info.
// Requires: lines:read AND the line must be within the caller's visibility scope.

type GrantRow = {
  id:               string
  line_id:          string
  granted_to:       string
  grantee_name:     string | null
  grantee_email:    string
  grantee_role:     string
  granted_by:       string
  granter_name:     string | null
  granter_email:    string
  created_at:       string
}

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lines', 'read')
  if (!auth.ok) return auth.response

  const lineId = new URL(req.url).searchParams.get('line_id')
  if (!lineId || !/^[0-9a-f-]{36}$/i.test(lineId))
    return NextResponse.json({ error: 'line_id is required and must be a valid UUID' }, { status: 400 })

  // Verify the line is within the caller's visibility scope
  const accessibleIds = await getAccessibleLineIds(auth.user)
  if (accessibleIds !== null && !accessibleIds.includes(lineId))
    return NextResponse.json({ error: 'Line not found or not accessible' }, { status: 404 })

  try {
    const grants = await query<GrantRow>(`
      SELECT
        lg.id,
        lg.line_id,
        lg.granted_to,
        grantee.name          AS grantee_name,
        grantee.email         AS grantee_email,
        grantee.role          AS grantee_role,
        lg.granted_by,
        granter.name          AS granter_name,
        granter.email         AS granter_email,
        lg.created_at
      FROM line_grants lg
      JOIN users grantee ON grantee.id = lg.granted_to
      JOIN users granter ON granter.id = lg.granted_by
      WHERE lg.line_id = $1
      ORDER BY lg.created_at DESC
    `, [lineId])

    return NextResponse.json({ grants })
  } catch (e) {
    console.error('[GET /api/lines/grants]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── POST /api/lines/grants — create a grant ───────────────────────────────────
// Body: { line_id, granted_to }
//
// Authorization:
//   - Actor must pass canManageLineGrant() check (owner / manager admin / super_admin).
//   - granted_to must be an active user.
//   - Actor must be able to access the line (accessible scope).
//   - Granting to oneself is rejected (no-op / confusing UX).

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lines', 'manage')
  if (!auth.ok) return auth.response

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(GrantLineSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'lines/grants')

  const { line_id, granted_to } = parsed.data
  const actorId = auth.user.user_id

  // Prevent granting access to yourself
  if (granted_to === actorId)
    return NextResponse.json({ error: 'No podés otorgarte acceso a tus propias líneas' }, { status: 400 })

  // Authorization: actor must have management rights over this line
  const allowed = await canManageLineGrant(actorId, line_id)
  if (!allowed)
    return NextResponse.json({ error: 'Forbidden: no tenés permisos para gestionar grants de esta línea' }, { status: 403 })

  // Validate the grantee exists and is active
  const [grantee] = await query<{ id: string; role: string; is_active: boolean; manager_id: string | null }>(
    'SELECT id, role, is_active, manager_id FROM users WHERE id = $1',
    [granted_to],
  )
  if (!grantee || !grantee.is_active)
    return NextResponse.json({ error: 'El usuario a quien se otorga el acceso no existe o está inactivo' }, { status: 404 })

  // Admins can only grant access to their own operators (manager_id = actorId).
  // super_admin can grant to anyone.
  if (!auth.user.is_super_admin) {
    const isOwnOperator = grantee.manager_id === actorId
    if (!isOwnOperator)
      return NextResponse.json(
        { error: 'Solo podés otorgar acceso a operadores que gestionás directamente' },
        { status: 403 },
      )
  }

  try {
    const [inserted] = await query<{ id: string }>(
      `INSERT INTO line_grants (line_id, granted_to, granted_by)
       VALUES ($1, $2, $3)
       ON CONFLICT ON CONSTRAINT uq_line_grant DO NOTHING
       RETURNING id`,
      [line_id, granted_to, actorId],
    )

    if (!inserted) {
      // Grant already exists — idempotent success
      return NextResponse.json({ ok: true, already_existed: true })
    }

    void audit({ req, action: 'create', resource: 'lines/grants', resource_id: inserted.id,
      metadata: { line_id, granted_to, granted_by: actorId } })

    return NextResponse.json({ ok: true, id: inserted.id }, { status: 201 })
  } catch (e) {
    console.error('[POST /api/lines/grants]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── DELETE /api/lines/grants — revoke a grant ─────────────────────────────────
// Body: { line_id, granted_to }
//
// Same authorization rules as POST.

export async function DELETE(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lines', 'manage')
  if (!auth.ok) return auth.response

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(RevokeGrantSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'lines/grants')

  const { line_id, granted_to } = parsed.data
  const actorId = auth.user.user_id

  // Authorization: actor must have management rights over this line
  const allowed = await canManageLineGrant(actorId, line_id)
  if (!allowed)
    return NextResponse.json({ error: 'Forbidden: no tenés permisos para gestionar grants de esta línea' }, { status: 403 })

  try {
    const rows = await query<{ id: string }>(
      `DELETE FROM line_grants
       WHERE line_id = $1 AND granted_to = $2
       RETURNING id`,
      [line_id, granted_to],
    )

    if (rows.length === 0)
      return NextResponse.json({ error: 'Grant not found' }, { status: 404 })

    void audit({ req, action: 'delete', resource: 'lines/grants', resource_id: rows[0].id,
      metadata: { line_id, granted_to, revoked_by: actorId } })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[DELETE /api/lines/grants]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
