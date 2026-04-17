import { NextRequest, NextResponse } from 'next/server'
import { randomBytes, createHmac } from 'node:crypto'

// ── In-memory rate limiter (failed attempts only) ─────────────────────────
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

// ── Token helpers ──────────────────────────────────────────────────────────
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30 // 30 days in seconds

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')
  return buf.toString('base64url')
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)

  // Check lockout before parsing body — pure read, no state mutation yet
  if (isRateLimited(ip)) {
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

  // Wrong credentials — record failure then return a generic error
  if (username !== validUser || password !== validPass) {
    recordFailedLogin(ip)
    return NextResponse.json({ error: 'Credenciales incorrectas' }, { status: 401 })
  }

  // Successful login — reset failure counter so prior failures don't linger
  clearFailedLogins(ip)

  // ── Signed session token ───────────────────────────────────────────────────
  // Format: base64url(payloadJson).base64url(hmacSha256Bytes)
  // Payload embeds iat, exp, and a random nonce so every token is unique.
  // AUTH_SECRET is the HMAC key — it is never stored in the cookie value.
  // Rotating AUTH_SECRET immediately invalidates all existing sessions.
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    nonce: randomBytes(16).toString('hex'),
    iat:   now,
    exp:   now + COOKIE_MAX_AGE,
  }
  const payloadB64 = b64url(JSON.stringify(payload))
  const sigBytes   = createHmac('sha256', secret).update(payloadB64).digest()
  const token      = `${payloadB64}.${b64url(sigBytes)}`

  const res = NextResponse.json({ ok: true })
  res.cookies.set('auth_token', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   COOKIE_MAX_AGE,
    path:     '/',
  })
  return res
}
