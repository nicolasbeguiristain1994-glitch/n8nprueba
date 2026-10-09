import bcryptjs from 'bcryptjs'
import { query, withTransaction } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermission, checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { parseBody, handleValidationError, UpdateUserSchema, type UpdateUserInput } from '@/lib/schema'
import { securityLog, appLog } from '@/lib/security-log'
import { lockManagedUser, protectLastAdmin } from '@/lib/user-management'

type UserRow = {
  id: string
  email: string
  name: string | null
  role: string
  sectors: string[]
  is_active: boolean
  session_version: number
  last_login_at: string | null
  created_at: string
  can_download_contacts: boolean
  allowed_agents: string[]
}

// ── GET /api/users/[id] ───────────────────────────────────────────────────────

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const err = await checkPermission(req, 'users', 'manage')
  if (err) return err

  try {
    const { id } = await params
    if (!isUUID(id)) return Response.json({ error: 'Invalid id' }, { status: 400 })

    const rows = await query<UserRow>(
      `SELECT id, email, name, role, sectors, is_active, session_version, last_login_at, created_at, can_download_contacts, allowed_agents
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    )

    if (!rows[0]) {
      return Response.json({ error: 'User not found' }, { status: 404 })
    }

    return Response.json({ user: rows[0] })
  } catch (e) {
    if (e instanceof Response) return e
    appLog('ERROR', 'GET /api/users/[id] failed', { error: (e as Error).message })
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── SET clause builder ────────────────────────────────────────────────────────

type SetClauseResult = {
  setClauses:      string[]
  queryParams:     unknown[]
  passwordChanged: boolean
}

/**
 * Translate a validated UpdateUserInput into a parameterised SQL SET clause.
 * Returns the clauses, the bound params, and whether the password was changed
 * (so the caller can build a safe changedFields list for the audit log).
 *
 * The WHERE id param must be appended by the caller:
 *   queryParams.push(id)
 *   `UPDATE users SET … WHERE id = $${queryParams.length}`
 */
async function buildUpdateSetClause(
  body:    UpdateUserInput,
  current: Pick<UserRow, 'role' | 'sectors' | 'is_active'>,
): Promise<SetClauseResult> {
  const roleChanged     = body.role     !== undefined && body.role     !== current.role
  const sectorsChanged  = body.sectors  !== undefined && JSON.stringify(body.sectors) !== JSON.stringify(current.sectors)
  const activeChanged   = body.is_active !== undefined && body.is_active !== current.is_active
  const passwordChanged = body.password  !== undefined && body.password !== ''
  const bumpSession     = roleChanged || sectorsChanged || activeChanged || passwordChanged

  const setClauses:  string[]  = ['updated_at = NOW()']
  const queryParams: unknown[] = []
  let   paramIdx = 1

  if (body.name               !== undefined) { setClauses.push(`name = $${paramIdx++}`);                queryParams.push(body.name?.trim() || null) }
  if (body.role               !== undefined) { setClauses.push(`role = $${paramIdx++}::user_role`);     queryParams.push(body.role) }
  if (body.sectors            !== undefined) { setClauses.push(`sectors = $${paramIdx++}::jsonb`);      queryParams.push(JSON.stringify(body.sectors)) }
  if (body.is_active          !== undefined) { setClauses.push(`is_active = $${paramIdx++}`);           queryParams.push(body.is_active) }
  if (body.can_download_contacts !== undefined) { setClauses.push(`can_download_contacts = $${paramIdx++}`); queryParams.push(body.can_download_contacts) }
  if (body.allowed_agents     !== undefined) { setClauses.push(`allowed_agents = $${paramIdx++}`);      queryParams.push(body.allowed_agents) }

  if (passwordChanged) {
    const hash = await bcryptjs.hash(body.password!, 12)
    setClauses.push(`password_hash = $${paramIdx++}`)
    queryParams.push(hash)
  }
  if (bumpSession) setClauses.push(`session_version = session_version + 1`)

  return { setClauses, queryParams, passwordChanged }
}

// ── PATCH /api/users/[id] ─────────────────────────────────────────────────────

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const err = await checkPermission(req, 'users', 'manage')
  if (err) return err

  try {
    const { id } = await params
    if (!isUUID(id)) return Response.json({ error: 'Invalid id' }, { status: 400 })

    const rawBody = await req.json().catch(() => null)
    const parsed  = parseBody(UpdateUserSchema, rawBody)
    if (!parsed.ok) return handleValidationError(req, parsed.error, 'users')
    const body = parsed.data

    const passwordChanged = body.password !== undefined && body.password !== ''
    await withTransaction(async (client) => {
      const current = await lockManagedUser(client, id)
      const newRole = body.role ?? current.role
      const newIsActive = body.is_active ?? current.is_active
      await protectLastAdmin(client, current, newRole !== 'admin' || !newIsActive)
      const { setClauses, queryParams } = await buildUpdateSetClause(body, current)
      queryParams.push(id)
      await client.query(`UPDATE users SET ${setClauses.join(', ')} WHERE id = $${queryParams.length} AND deleted_at IS NULL`, queryParams)
    })

    const changedFields: string[] = []
    if ('name'      in body && body.name      !== undefined) changedFields.push('name')
    if ('role'      in body && body.role      !== undefined) changedFields.push('role')
    if ('sectors'   in body && body.sectors   !== undefined) changedFields.push('sectors')
    if ('is_active' in body && body.is_active !== undefined) changedFields.push('is_active')
    if (passwordChanged) changedFields.push('password_changed')
    if ('can_download_contacts' in body) changedFields.push('can_download_contacts')
    if ('allowed_agents' in body) changedFields.push('allowed_agents')

    void audit({ req, action: 'update', resource: 'users', resource_id: id,
      metadata: { changedFields } })

    if (changedFields.includes('role')) {
      securityLog('user_role_changed', { targetUserId: id, newRole: body.role })
    }
    if (changedFields.includes('is_active') && body.is_active === false) {
      securityLog('user_deactivated', { targetUserId: id, via: 'patch' })
    }

    return Response.json({ ok: true })
  } catch (e) {
    if (e instanceof Response) return e
    appLog('ERROR', 'PATCH /api/users/[id] failed', { error: (e as Error).message })
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── DELETE /api/users/[id] (soft delete) ─────────────────────────────────────

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'users', 'delete')
  if (!auth.ok) return auth.response

  try {
    const { id } = await params
    if (!isUUID(id)) return Response.json({ error: 'Invalid id' }, { status: 400 })
    if (id === auth.user.user_id) return Response.json(
      { error: 'No podés eliminar la cuenta con la que estás conectado' }, { status: 400 })

    await withTransaction(async (client) => {
      const current = await lockManagedUser(client, id)
      await protectLastAdmin(client, current, true)
      await client.query(
        `UPDATE users SET deleted_at=NOW(), deleted_by=$2, is_active=false,
          session_version=session_version+1, updated_at=NOW() WHERE id=$1`,
        [id, auth.user.user_id])
    })

    void audit({ req, action: 'delete', resource: 'users', resource_id: id,
      metadata: { history_preserved: true } })
    securityLog('user_deactivated', { targetUserId: id, via: 'delete' })
    return Response.json({ ok: true })
  } catch (e) {
    if (e instanceof Response) return e
    appLog('ERROR', 'DELETE /api/users/[id] failed', { error: (e as Error).message })
    return Response.json({ error: 'No se pudo eliminar el usuario' }, { status: 500 })
  }
}
