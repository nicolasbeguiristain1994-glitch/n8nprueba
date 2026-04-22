import { NextRequest, NextResponse } from 'next/server'
import bcryptjs from 'bcryptjs'
import { query } from '@/lib/db'
import { createSessionToken, SESSION_DURATION_SECONDS } from '@/lib/auth'
import type { SessionUser } from '@/lib/auth'

// ── In-memory rate limiter (failed attempts only) ─────────────────────────────
// Tracks FAILED credential attempts only. Successful logins do not consume
// the budget and clear the counter for that IP.
// Single-instance only. If Railway scales to multiple instances, move to Redis.
const failedAttempts = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX    = 10              // failed attempts before lockout
const RATE_LIMIT_WINDOW = 15 * 60 * 1000 // 15-minute window in ms

function getClientIp(req: NextRequest): string {
  // Railway sets x-forwarded-for; fall back to x-real-ip, then 'unknown'
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  )
}

/** Pure read — returns true if IP has exceeded the failed-attempt limit. */
function isRateLimited(ip: string): boolean {
  const entry = failedAttempts.get(ip)
  if (!entry || Date.now() > entry.resetAt) return false
  return entry.count >= RATE_LIMIT_MAX
}

/** Record one failed credential attempt for this IP. */
function recordFailedLogin(ip: string): void {
  const now = Date.now()
  const entry = failedAttempts.get(ip)
  if (!entry || now > entry.resetAt) {
    failedAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW })
  } else {
    entry.count++
  }
}

/** Reset failed-attempt counter after a successful login. */
function clearFailedLogins(ip: string): void {
  failedAttempts.delete(ip)
}

// ── Cookie config ─────────────────────────────────────────────────────────────

const COOKIE_MAX_AGE = SESSION_DURATION_SECONDS // 7 days

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)

  // Check lockout before parsing body — pure read, no state mutation yet
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

  // Accept both 'email' and legacy 'username' fields
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

  // ── Check if users table has any rows ─────────────────────────────────────
  // Bootstrap fallback: if table is empty (or doesn't exist), allow login
  // with AUTH_USERNAME + AUTH_PASSWORD env vars.
  let userCount = 0
  try {
    const countRows = await query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users')
    userCount = parseInt(countRows[0]?.count ?? '0', 10)
    console.log('[login] DB connected, user count:', userCount)
  } catch (dbErr) {
    console.error('[login] DB query failed, falling back to bootstrap:', (dbErr as Error).message)
    userCount = 0
  }

  // ── Bootstrap mode ────────────────────────────────────────────────────────
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
      warning:   'No users in DB. Create an admin user and disable bootstrap mode.',
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

  // ── Normal DB-backed login ────────────────────────────────────────────────
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

  let userRows: UserRow[]
  try {
    userRows = await query<UserRow>(
      'SELECT id, email, name, role, sectors, password_hash, is_active, session_version FROM users WHERE LOWER(email) = $1',
      [email]
    )
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  const user = userRows[0]

  // Generic error — do not reveal whether email exists
  const credentialError = () => {
    recordFailedLogin(ip)
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }

  if (!user)            return credentialError()
  if (!user.is_active)  return credentialError()

  const passwordMatch = await bcryptjs.compare(password, user.password_hash)
  if (!passwordMatch)   return credentialError()

  // Successful login
  clearFailedLogins(ip)

  // Update last_login_at — fire-and-forget, non-fatal
  query('UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1', [user.id]).catch(() => {})

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
