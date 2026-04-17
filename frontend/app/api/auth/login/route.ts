import { NextRequest, NextResponse } from 'next/server'
import { randomBytes, createHmac } from 'node:crypto'

// ── In-memory rate limiter ─────────────────────────────────────────────────
// Single-instance only. If Railway ever scales to multiple instances, move
// rate state to Redis (INCR + EXPIRE).
const loginAttempts = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX    = 10              // attempts allowed per window
const RATE_LIMIT_WINDOW = 15 * 60 * 1000 // 15 minutes in ms

function getClientIp(req: NextRequest): string {
  // Railway sets x-forwarded-for; fall back to x-real-ip, then 'unknown'
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  )
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = loginAttempts.get(ip)

  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW })
    return false // not limited
  }

  entry.count++
  return entry.count > RATE_LIMIT_MAX // limited if over threshold
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (checkRateLimit(ip)) {
    return NextResponse.json(
      { error: 'Demasiados intentos. Intentá de nuevo en 15 minutos.' },
      { status: 429 }
    )
  }

  let body: { username?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { username, password } = body

  const validUser = process.env.AUTH_USERNAME
  const validPass = process.env.AUTH_PASSWORD
  const secret    = process.env.AUTH_SECRET

  if (!validUser || !validPass || !secret) {
    return NextResponse.json({ error: 'Auth not configured' }, { status: 500 })
  }

  if (username !== validUser || password !== validPass) {
    return NextResponse.json({ error: 'Credenciales incorrectas' }, { status: 401 })
  }

  // ── Signed session token ───────────────────────────────────────────────────
  // Format: {64-char random hex}.{HMAC-SHA256(secret, payload) hex}
  // AUTH_SECRET is the signing key — it is never stored in the cookie.
  // Rotating AUTH_SECRET immediately invalidates all existing sessions.
  const payload = randomBytes(32).toString('hex')
  const sig     = createHmac('sha256', secret).update(payload).digest('hex')
  const token   = `${payload}.${sig}`

  const res = NextResponse.json({ ok: true })
  res.cookies.set('auth_token', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   60 * 60 * 24 * 30, // 30 days
    path:     '/',
  })
  return res
}
