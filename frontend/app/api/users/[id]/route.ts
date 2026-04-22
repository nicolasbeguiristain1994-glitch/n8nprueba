import bcryptjs from 'bcryptjs'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'

const VALID_ROLES   = ['admin', 'operator', 'viewer'] as const
const VALID_SECTORS = ['dashboard', 'contacts', 'campaigns', 'conversations', 'lines', 'warmup', 'users', 'settings', 'lists', 'send'] as const

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
}

// ── GET /api/users/[id] ───────────────────────────────────────────────────────

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const err = await checkPermission(req, 'users', 'manage')
  if (err) return err

  try {
    const { id } = await params

    const rows = await query<UserRow>(
      `SELECT id, email, name, role, sectors, is_active, session_version, last_login_at, created_at
       FROM users WHERE id = $1`,
      [id]
    )

    if (!rows[0]) {
      return Response.json({ error: 'User not found' }, { status: 404 })
    }

    return Response.json({ user: rows[0] })
  } catch (e) {
    if (e instanceof Response) return e
    console.error('[GET /api/users/[id]]', e)
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── PATCH /api/users/[id] ─────────────────────────────────────────────────────

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const err = await checkPermission(req, 'users', 'manage')
  if (err) return err

  try {
    const { id } = await params

    let body: {
      name?: string
      role?: string
      sectors?: unknown
      is_active?: unknown
      password?: string
    }
    try {
      body = await req.json()
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    // Fetch current user
    const existing = await query<UserRow>(
      `SELECT id, role, sectors, is_active, session_version FROM users WHERE id = $1`,
      [id]
    )
    if (!existing[0]) {
      return Response.json({ error: 'User not found' }, { status: 404 })
    }

    const current = existing[0]
    const errs: string[] = []

    // Validate fields if provided
    if ('role' in body && body.role !== undefined) {
      if (!VALID_ROLES.includes(body.role as typeof VALID_ROLES[number])) {
        errs.push(`role must be one of: ${VALID_ROLES.join(', ')}`)
      }
    }
    if ('sectors' in body && body.sectors !== undefined) {
      if (!Array.isArray(body.sectors)) {
        errs.push('sectors must be an array')
      } else {
        const invalid = (body.sectors as unknown[]).filter(
          s => typeof s !== 'string' || !VALID_SECTORS.includes(s as typeof VALID_SECTORS[number])
        )
        if (invalid.length) errs.push(`invalid sectors: ${invalid.join(', ')}`)
      }
    }
    if ('is_active' in body && body.is_active !== undefined && typeof body.is_active !== 'boolean') {
      errs.push('is_active must be a boolean')
    }
    if ('password' in body && body.password !== undefined) {
      if ((body.password || '').length < 10) errs.push('password must be at least 10 characters')
    }

    if (errs.length) {
      return Response.json({ error: errs.join('; ') }, { status: 400 })
    }

    // Guard: do not allow demoting/deactivating the last admin
    const newRole     = (body.role !== undefined ? body.role : current.role) as string
    const newIsActive = body.is_active !== undefined ? (body.is_active as boolean) : current.is_active

    if ((newRole !== 'admin' || newIsActive === false) && current.role === 'admin') {
      const adminCountRows = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM users WHERE role = 'admin' AND is_active = true`
      )
      const adminCount = parseInt(adminCountRows[0]?.count ?? '0', 10)
      if (adminCount <= 1) {
        return Response.json(
          { error: 'Cannot demote or deactivate the last active admin' },
          { status: 400 }
        )
      }
    }

    // Determine if session_version should be incremented
    const roleChanged     = body.role     !== undefined && body.role     !== current.role
    const sectorsChanged  = body.sectors  !== undefined && JSON.stringify(body.sectors) !== JSON.stringify(current.sectors)
    const activeChanged   = body.is_active !== undefined && body.is_active !== current.is_active
    const passwordChanged = body.password  !== undefined && body.password !== ''

    const bumpSession = roleChanged || sectorsChanged || activeChanged || passwordChanged

    // Build update
    const setClauses: string[] = ['updated_at = NOW()']
    const queryParams: unknown[] = []
    let   paramIdx = 1

    if ('name' in body && body.name !== undefined) {
      setClauses.push(`name = $${paramIdx++}`)
      queryParams.push(body.name?.trim() || null)
    }
    if ('role' in body && body.role !== undefined) {
      setClauses.push(`role = $${paramIdx++}::user_role`)
      queryParams.push(body.role)
    }
    if ('sectors' in body && body.sectors !== undefined) {
      setClauses.push(`sectors = $${paramIdx++}::jsonb`)
      queryParams.push(JSON.stringify(body.sectors))
    }
    if ('is_active' in body && body.is_active !== undefined) {
      setClauses.push(`is_active = $${paramIdx++}`)
      queryParams.push(body.is_active)
    }
    if (passwordChanged) {
      const hash = await bcryptjs.hash(body.password!, 12)
      setClauses.push(`password_hash = $${paramIdx++}`)
      queryParams.push(hash)
    }
    if (bumpSession) {
      setClauses.push(`session_version = session_version + 1`)
    }

    queryParams.push(id)
    const updateSql = `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING id`
    await query(updateSql, queryParams)

    const changedFields: string[] = []
    if ('name'      in body && body.name      !== undefined) changedFields.push('name')
    if ('role'      in body && body.role      !== undefined) changedFields.push('role')
    if ('sectors'   in body && body.sectors   !== undefined) changedFields.push('sectors')
    if ('is_active' in body && body.is_active !== undefined) changedFields.push('is_active')
    if (passwordChanged) changedFields.push('password_changed')

    void audit({ req, action: 'update', resource: 'users', resource_id: id,
      metadata: { changedFields } })
    return Response.json({ ok: true })
  } catch (e) {
    if (e instanceof Response) return e
    console.error('[PATCH /api/users/[id]]', e)
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── DELETE /api/users/[id] (soft delete) ─────────────────────────────────────

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const err = await checkPermission(req, 'users', 'manage')
  if (err) return err

  try {
    const { id } = await params

    // Fetch current user
    const existing = await query<{ role: string; is_active: boolean }>(
      `SELECT role, is_active FROM users WHERE id = $1`,
      [id]
    )
    if (!existing[0]) {
      return Response.json({ error: 'User not found' }, { status: 404 })
    }

    // Guard: do not allow deactivating the last admin
    if (existing[0].role === 'admin' && existing[0].is_active) {
      const adminCountRows = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM users WHERE role = 'admin' AND is_active = true`
      )
      const adminCount = parseInt(adminCountRows[0]?.count ?? '0', 10)
      if (adminCount <= 1) {
        return Response.json(
          { error: 'Cannot deactivate the last active admin' },
          { status: 400 }
        )
      }
    }

    // Soft delete: deactivate + invalidate all sessions
    await query(
      `UPDATE users SET is_active = false, session_version = session_version + 1, updated_at = NOW() WHERE id = $1`,
      [id]
    )

    void audit({ req, action: 'delete', resource: 'users', resource_id: id })
    return Response.json({ ok: true })
  } catch (e) {
    if (e instanceof Response) return e
    console.error('[DELETE /api/users/[id]]', e)
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
