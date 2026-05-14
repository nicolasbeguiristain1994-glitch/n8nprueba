import bcryptjs from 'bcryptjs'
import { query, withTransaction } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { parseBody, handleValidationError, UpdateUserSchema, type UpdateUserInput } from '@/lib/schema'
import { securityLog, appLog } from '@/lib/security-log'

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
       FROM users WHERE id = $1`,
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

    // Fetch current user (outside transaction for validation/diff)
    const existing = await query<UserRow>(
      `SELECT id, role, sectors, is_active, session_version FROM users WHERE id = $1`,
      [id]
    )
    if (!existing[0]) {
      return Response.json({ error: 'User not found' }, { status: 404 })
    }

    const current          = existing[0]
    const newRole          = (body.role     !== undefined ? body.role     : current.role) as string
    const newIsActive      = body.is_active !== undefined ? body.is_active : current.is_active
    const adminGuardNeeded = (newRole !== 'admin' || newIsActive === false) && current.role === 'admin'

    // Build SET clause outside the transaction (bcrypt hash is computed here)
    const { setClauses, queryParams, passwordChanged } = await buildUpdateSetClause(body, current)
    queryParams.push(id)
    const updateSql = `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${queryParams.length} RETURNING id`

    // Transaction: lock active admins before guard check + update to prevent race condition
    await withTransaction(async (client) => {
      if (adminGuardNeeded) {
        // Row-level lock prevents concurrent demotions from both passing the guard
        const { rows: adminRows } = await client.query<{ id: string }>(
          `SELECT id FROM users WHERE role = 'admin' AND is_active = true FOR UPDATE`
        )
        if (adminRows.length <= 1) {
          throw Response.json(
            { error: 'Cannot demote or deactivate the last active admin' },
            { status: 400 }
          )
        }
      }
      const { rows: updatedRows } = await client.query<{ id: string }>(updateSql, queryParams)
      if (!updatedRows[0]) {
        throw Response.json({ error: 'User not found' }, { status: 404 })
      }
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
  const err = await checkPermission(req, 'users', 'manage')
  if (err) return err

  try {
    const { id } = await params
    if (!isUUID(id)) return Response.json({ error: 'Invalid id' }, { status: 400 })

    // Transaction: lock active admins before guard check + soft-delete to prevent race condition
    await withTransaction(async (client) => {
      const { rows: existing } = await client.query<{ role: string; is_active: boolean }>(
        `SELECT role, is_active FROM users WHERE id = $1`,
        [id]
      )
      if (!existing[0]) {
        throw Response.json({ error: 'User not found' }, { status: 404 })
      }

      // Guard: do not allow deactivating the last admin
      if (existing[0].role === 'admin' && existing[0].is_active) {
        const { rows: adminRows } = await client.query<{ id: string }>(
          `SELECT id FROM users WHERE role = 'admin' AND is_active = true FOR UPDATE`
        )
        if (adminRows.length <= 1) {
          throw Response.json(
            { error: 'Cannot deactivate the last active admin' },
            { status: 400 }
          )
        }
      }

      // Soft delete: deactivate + invalidate all sessions
      await client.query(
        `UPDATE users SET is_active = false, session_version = session_version + 1, updated_at = NOW() WHERE id = $1`,
        [id]
      )
    })

    void audit({ req, action: 'delete', resource: 'users', resource_id: id })
    securityLog('user_deactivated', { targetUserId: id, via: 'delete' })

    return Response.json({ ok: true })
  } catch (e) {
    if (e instanceof Response) return e
    appLog('ERROR', 'DELETE /api/users/[id] failed', { error: (e as Error).message })
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
