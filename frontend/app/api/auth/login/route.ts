import { NextRequest, NextResponse } from 'next/server'
import bcryptjs from 'bcryptjs'
import { type PoolClient } from 'pg'
import { getDbClient, pool } from '@/lib/db'
import { createSessionToken, SESSION_DURATION_SECONDS } from '@/lib/auth'
import type { SessionUser } from '@/lib/auth'

// ── In-memory rate limiter (failed attempts only) ─────────────────────────────
const failedAttempts = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX    = 10
const RATE_LIMIT_WINDOW = 15 * 60 * 1000

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  )
}

function isRateLimited(ip: string): boolean {
  const entry = failedAttempts.get(ip)
  if (!entry || Date.now() > entry.resetAt) return false
  return entry.count >= RATE_LIMIT_MAX
}

function recordFailedLogin(ip: string): void {
  const now = Date.now()
  const entry = failedAttempts.get(ip)
  if (!entry || now > entry.resetAt) {
    failedAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW })
  } else {
    entry.count++
  }
}

function clearFailedLogins(ip: string): void {
  failedAttempts.delete(ip)
}

// ── Cookie config ─────────────────────────────────────────────────────────────
const COOKIE_MAX_AGE = SESSION_DURATION_SECONDS // 7 days

type UserRow = {
  id: string
  email: string
  name: string | null
  role: 'admin' | 'operator' | 'viewer'
  sectors: string[]
  password_hash: string
  is_active: boolean
  session_version: number
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)

  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: 'Demasiados intentos. Intentá de nuevo en 15 minutos.' },
      { status: 429 }
    )
  }

  let body: { email?: string; password?: string; username?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const rawEmail = (body.email || body.username || '').trim()
  const password = body.password || ''

  if (!rawEmail || !password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })
  }

  const email  = rawEmail.toLowerCase().trim()
  const secret = process.env.AUTH_SECRET

  if (!secret) {
    return NextResponse.json({ error: 'Auth not configured' }, { status: 500 })
  }

  console.log('[login] start')
  console.log('[login] pool before acquire — total:', pool.totalCount, 'idle:', pool.idleCount, 'waiting:', pool.waitingCount)

  // ── Single DB client for all queries ─────────────────────────────────────
  // Avoids pool exhaustion between consecutive queries over PgBouncer.
  let dbClient: PoolClient | undefined
  let userCount = 0
  let userRow:   UserRow | undefined

  try {
    dbClient = await getDbClient()
    console.log('[login] client acquired')

    // Step 1 — bootstrap check
    const t1 = Date.now()
    const countResult = await dbClient.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM users'
    )
    userCount = parseInt(countResult.rows[0]?.count ?? '0', 10)
    console.log('[login] step1 COUNT done in', Date.now() - t1, 'ms, count:', userCount)

    if (userCount > 0) {
      // Step 2 — fetch user
      const t2 = Date.now()
      const userResult = await dbClient.query<UserRow>(
        'SELECT id, email, name, role, sectors, password_hash, is_active, session_version FROM users WHERE LOWER(email) = $1',
        [email]
      )
      console.log('[login] step2 SELECT done in', Date.now() - t2, 'ms, found:', userResult.rows.length)
      userRow = userResult.rows[0]

      if (!userRow || !userRow.is_active) {
        recordFailedLogin(ip)
        console.log('[login] returning invalid credentials (user not found or inactive)')
        return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
      }

      // Step 3 — bcrypt compare
      const t3 = Date.now()
      console.log('[login] step3 starting bcrypt compare...')
      const passwordMatch = await bcryptjs.compare(password, userRow.password_hash)
      console.log('[login] step3 bcrypt done in', Date.now() - t3, 'ms, match:', passwordMatch)

      if (!passwordMatch) {
        recordFailedLogin(ip)
        console.log('[login] returning invalid credentials (password mismatch)')
        return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
      }

      // Step 4 — update last_login_at (same client, non-fatal)
      try {
        const t4 = Date.now()
        await dbClient.query(
          'UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1',
          [userRow.id]
        )
        console.log('[login] step4 last_login_at done in', Date.now() - t4, 'ms')
      } catch (e) {
        console.error('[login] step4 last_login_at failed (non-fatal):', (e as Error).message)
      }
    }

  } catch (e) {
    console.error('[login] DB error:', (e as Error).message)
    console.log('[login] returning service unavailable')
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  } finally {
    if (dbClient) {
      dbClient.release()
      console.log('[login] pool after release — total:', pool.totalCount, 'idle:', pool.idleCount, 'waiting:', pool.waitingCount)
      dbClient = undefined
    }
  }

  // ── Bootstrap mode (users table empty or does not exist) ─────────────────
  if (userCount === 0) {
    const bootstrapUser = process.env.AUTH_USERNAME
    const bootstrapPass = process.env.AUTH_PASSWORD

    if (!bootstrapUser || !bootstrapPass) {
      recordFailedLogin(ip)
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    const emailMatch = email === bootstrapUser.toLowerCase().trim()
    const passMatch  = password === bootstrapPass

    if (!emailMatch || !passMatch) {
      recordFailedLogin(ip)
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    clearFailedLogins(ip)

    const now = Math.floor(Date.now() / 1000)
    const sessionPayload: SessionUser = {
      user_id:         'bootstrap',
      email:           bootstrapUser.toLowerCase().trim(),
      name:            'Bootstrap Admin',
      role:            'admin',
      sectors:         [],
      session_version: 1,
      iat:             now,
      exp:             now + COOKIE_MAX_AGE,
      nonce:           crypto.randomUUID(),
    }

    const token = createSessionToken(sessionPayload)
    const res = NextResponse.json({
      ok:        true,
      bootstrap: true,
      warning:   'No users in DB. Create an admin user to disable bootstrap mode.',
      user: {
        id:      'bootstrap',
        email:   sessionPayload.email,
        name:    'Bootstrap Admin',
        role:    'admin',
        sectors: [],
      },
    })
    res.cookies.set('session', token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge:   COOKIE_MAX_AGE,
      path:     '/',
    })
    return res
  }

  // ── Successful DB-backed login ────────────────────────────────────────────
  const user = userRow!
  clearFailedLogins(ip)

  const now = Math.floor(Date.now() / 1000)
  const sessionPayload: SessionUser = {
    user_id:         user.id,
    email:           user.email,
    name:            user.name,
    role:            user.role,
    sectors:         Array.isArray(user.sectors) ? user.sectors : [],
    session_version: user.session_version,
    iat:             now,
    exp:             now + COOKIE_MAX_AGE,
    nonce:           crypto.randomUUID(),
  }

  const token = createSessionToken(sessionPayload)
  console.log('[login] returning success')

  const res = NextResponse.json({
    ok: true,
    user: {
      id:      user.id,
      email:   user.email,
      name:    user.name,
      role:    user.role,
      sectors: Array.isArray(user.sectors) ? user.sectors : [],
    },
  })
  res.cookies.set('session', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   COOKIE_MAX_AGE,
    path:     '/',
  })
  return res
}
