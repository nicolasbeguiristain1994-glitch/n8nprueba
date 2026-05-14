import { NextRequest, NextResponse } from 'next/server'
import bcryptjs from 'bcryptjs'
import { type PoolClient } from 'pg'
import { getDbClient } from '@/lib/db'
import { createSessionToken, SESSION_DURATION_SECONDS } from '@/lib/auth'
import type { SessionUser } from '@/lib/auth'
import { loginRateLimiter } from '@/lib/rate-limit'
import { audit } from '@/lib/audit'
import { securityLog, appLog } from '@/lib/security-log'

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  )
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
  can_download_contacts: boolean
  allowed_agents: string[]
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)

  if (await loginRateLimiter.isBlocked(ip)) {
    securityLog('rate_limit_exceeded', { ip })
    void audit({ req, action: 'rate_limit_exceeded', resource: 'auth', status: 'denied',
      metadata: { ip } })
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

  // ── Single DB client for all queries ─────────────────────────────────────
  // Avoids pool exhaustion between consecutive queries over PgBouncer.
  let dbClient: PoolClient | undefined
  let userCount = 0
  let userRow:   UserRow | undefined

  try {
    dbClient = await getDbClient()

    // Step 1 — bootstrap check
    const countResult = await dbClient.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM users'
    )
    userCount = parseInt(countResult.rows[0]?.count ?? '0', 10)

    if (userCount > 0) {
      // Step 2 — fetch user
      const userResult = await dbClient.query<UserRow>(
        'SELECT id, email, name, role, sectors, password_hash, is_active, session_version, can_download_contacts, allowed_agents FROM users WHERE LOWER(email) = $1',
        [email]
      )
      userRow = userResult.rows[0]

      if (!userRow || !userRow.is_active) {
        const reason = userRow ? 'account_inactive' : 'user_not_found'
        await loginRateLimiter.increment(ip)
        securityLog('login_failed', { ip, email, reason })
        void audit({ req, action: 'login_failed', resource: 'auth', status: 'failure',
          metadata: { reason, email } })
        return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
      }

      // Step 3 — bcrypt compare
      const passwordMatch = await bcryptjs.compare(password, userRow.password_hash)

      if (!passwordMatch) {
        await loginRateLimiter.increment(ip)
        securityLog('login_failed', { ip, email: userRow.email, reason: 'password_mismatch' })
        void audit({ req, action: 'login_failed', resource: 'auth', status: 'failure',
          userOverride: { userId: userRow.id, email: userRow.email, role: userRow.role },
          metadata: { reason: 'password_mismatch' } })
        return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
      }

      // Step 4 — update last_login_at (same client, non-fatal)
      try {
        await dbClient.query(
          'UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1',
          [userRow.id]
        )
      } catch (e) {
        appLog('WARN', 'login last_login_at update failed', { error: (e as Error).message })
      }
    }

  } catch (e) {
    appLog('ERROR', 'login DB error', { error: (e as Error).message, ip })
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 })
  } finally {
    if (dbClient) {
      dbClient.release()
      dbClient = undefined
    }
  }

  // ── Bootstrap mode (users table empty or does not exist) ─────────────────
  if (userCount === 0) {
    const bootstrapUser = process.env.AUTH_USERNAME
    const bootstrapPass = process.env.AUTH_PASSWORD

    if (!bootstrapUser || !bootstrapPass) {
      await loginRateLimiter.increment(ip)
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    const emailMatch = email === bootstrapUser.toLowerCase().trim()
    const passMatch  = password === bootstrapPass

    if (!emailMatch || !passMatch) {
      await loginRateLimiter.increment(ip)
      securityLog('login_failed', { ip, email, reason: 'bootstrap_credentials_invalid' })
      void audit({ req, action: 'login_failed', resource: 'auth', status: 'failure',
        userOverride: { userId: null, email, role: null },
        metadata: { reason: 'bootstrap_credentials_invalid' } })
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    await loginRateLimiter.reset(ip)
    securityLog('bootstrap_login', { ip, email: bootstrapUser.toLowerCase().trim() })
    void audit({ req, action: 'login_success', resource: 'auth',
      userOverride: { userId: null, email: bootstrapUser.toLowerCase().trim(), role: 'admin' },
      metadata: { bootstrap: true } })

    const now = Math.floor(Date.now() / 1000)
    const sessionPayload: SessionUser = {
      user_id:               'bootstrap',
      email:                 bootstrapUser.toLowerCase().trim(),
      name:                  'Bootstrap Admin',
      role:                  'admin',
      sectors:               [],
      session_version:       1,
      can_download_contacts: true,
      allowed_agents:        [],
      iat:                   now,
      exp:                   now + COOKIE_MAX_AGE,
      nonce:                 crypto.randomUUID(),
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
      sameSite: 'strict',
      maxAge:   COOKIE_MAX_AGE,
      path:     '/',
    })
    return res
  }

  // ── Successful DB-backed login ────────────────────────────────────────────
  const user = userRow!
  await loginRateLimiter.reset(ip)
  securityLog('login_success', { ip, userId: user.id, email: user.email, role: user.role })
  void audit({ req, action: 'login_success', resource: 'auth',
    userOverride: { userId: user.id, email: user.email, role: user.role } })

  const now = Math.floor(Date.now() / 1000)
  const sessionPayload: SessionUser = {
    user_id:               user.id,
    email:                 user.email,
    name:                  user.name,
    role:                  user.role,
    sectors:               Array.isArray(user.sectors) ? user.sectors : [],
    session_version:       user.session_version,
    can_download_contacts: user.can_download_contacts ?? true,
    allowed_agents:        Array.isArray(user.allowed_agents) ? user.allowed_agents : [],
    iat:                   now,
    exp:                   now + COOKIE_MAX_AGE,
    nonce:                 crypto.randomUUID(),
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
    sameSite: 'strict',
    maxAge:   COOKIE_MAX_AGE,
    path:     '/',
  })
  return res
}
