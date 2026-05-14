import bcryptjs from 'bcryptjs'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { parseBody, handleValidationError, CreateUserSchema } from '@/lib/schema'

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
    const rawBody = await req.json().catch(() => null)
    const parsed  = parseBody(CreateUserSchema, rawBody)
    if (!parsed.ok) return handleValidationError(req, parsed.error, 'users')

    const { email, password, name, role, sectors, can_download_contacts, allowed_agents } = parsed.data

    const passwordHash = await bcryptjs.hash(password, 12)

    const rows = await query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, role, sectors, is_active, can_download_contacts, allowed_agents)
       VALUES ($1, $2, $3, $4::user_role, $5::jsonb, true, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [email, passwordHash, name ?? null, role, JSON.stringify(sectors), can_download_contacts, allowed_agents],
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
