import bcryptjs from 'bcryptjs'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'

const VALID_ROLES    = ['admin', 'operator', 'viewer'] as const
const VALID_SECTORS  = ['dashboard', 'contacts', 'campaigns', 'conversations', 'lines', 'warmup', 'users', 'settings', 'lists', 'send'] as const

type UserRow = {
  id: string
  email: string
  name: string | null
  role: string
  sectors: string[]
  is_active: boolean
  last_login_at: string | null
  created_at: string
  can_download_contacts: boolean
  allowed_agents: string[]
}

// ── GET /api/users ────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const err = await checkPermission(req, 'users', 'manage')
  if (err) return err

  try {
    const url    = new URL(req.url)
    const page   = Math.max(1, parseInt(url.searchParams.get('page')  || '1', 10))
    const limit  = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)))
    const search = url.searchParams.get('search')?.trim() || ''
    const offset = (page - 1) * limit

    let sql: string
    let params: unknown[]

    if (search) {
      sql = `
        SELECT id, email, name, role, sectors, is_active, last_login_at, created_at, can_download_contacts, allowed_agents
        FROM users
        WHERE (LOWER(email) LIKE $1 OR LOWER(name) LIKE $1)
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `
      params = [`%${search.toLowerCase()}%`, limit, offset]
    } else {
      sql = `
        SELECT id, email, name, role, sectors, is_active, last_login_at, created_at, can_download_contacts, allowed_agents
        FROM users
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `
      params = [limit, offset]
    }

    const rows = await query<UserRow>(sql, params)

    // Count total
    const countSql = search
      ? `SELECT COUNT(*)::text AS count FROM users WHERE (LOWER(email) LIKE $1 OR LOWER(name) LIKE $1)`
      : `SELECT COUNT(*)::text AS count FROM users`
    const countParams = search ? [`%${search.toLowerCase()}%`] : []
    const countRows = await query<{ count: string }>(countSql, countParams)
    const total = parseInt(countRows[0]?.count ?? '0', 10)

    return Response.json({
      users: rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    })
  } catch (e) {
    if (e instanceof Response) return e
    console.error('[GET /api/users]', e)
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── POST /api/users ───────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const err = await checkPermission(req, 'users', 'manage')
  if (err) return err

  try {
    let body: {
      email?: string
      password?: string
      name?: string
      role?: string
      sectors?: unknown
      can_download_contacts?: boolean
      allowed_agents?: unknown
    }
    try {
      body = await req.json()
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const email    = (body.email || '').toLowerCase().trim()
    const password = body.password || ''
    const name     = body.name?.trim() || null
    const role     = body.role || ''
    const sectors  = body.sectors

    // Validation
    const errs: string[] = []
    if (!email)              errs.push('email is required')
    if (!password)           errs.push('password is required')
    if (password.length < 10 && password) errs.push('password must be at least 10 characters')
    if (!VALID_ROLES.includes(role as typeof VALID_ROLES[number])) {
      errs.push(`role must be one of: ${VALID_ROLES.join(', ')}`)
    }
    if (!Array.isArray(sectors)) {
      errs.push('sectors must be an array')
    } else {
      const invalidSectors = (sectors as unknown[]).filter(
        s => typeof s !== 'string' || !VALID_SECTORS.includes(s as typeof VALID_SECTORS[number])
      )
      if (invalidSectors.length) {
        errs.push(`invalid sectors: ${invalidSectors.join(', ')}. Valid: ${VALID_SECTORS.join(', ')}`)
      }
    }

    if (errs.length) {
      return Response.json({ error: errs.join('; ') }, { status: 400 })
    }

    const can_download = body.can_download_contacts !== undefined ? Boolean(body.can_download_contacts) : true
    const allowed_agts = Array.isArray(body.allowed_agents)
      ? (body.allowed_agents as unknown[]).filter((a): a is string => typeof a === 'string')
      : []

    const passwordHash = await bcryptjs.hash(password, 12)

    const rows = await query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, role, sectors, is_active, can_download_contacts, allowed_agents)
       VALUES ($1, $2, $3, $4::user_role, $5::jsonb, true, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [email, passwordHash, name, role, JSON.stringify(sectors), can_download, allowed_agts]
    )

    if (!rows[0]) {
      return Response.json({ error: 'A user with that email already exists' }, { status: 409 })
    }

    void audit({ req, action: 'create', resource: 'users', resource_id: rows[0].id,
      metadata: { email, role } })
    return Response.json({ ok: true, id: rows[0].id }, { status: 201 })
  } catch (e) {
    if (e instanceof Response) return e
    console.error('[POST /api/users]', e)
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}
