import { createHmac } from 'node:crypto'
import { cookies } from 'next/headers'

// ── Session type ──────────────────────────────────────────────────────────────

export type SessionUser = {
  user_id: string
  email: string
  name: string | null
  role: 'admin' | 'operator' | 'viewer'
  sectors: string[]
  session_version: number
  iat: number
  exp: number
  nonce: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const SESSION_DURATION_SECONDS = 86400 * 7 // 7 days

// ── Token helpers (matches middleware and login route exactly) ─────────────────
// Format: base64url(payloadJson).base64url(hmacSha256Bytes)

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')
  return buf.toString('base64url')
}

function b64urlDecode(s: string): Buffer {
  const base64 = s
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(s.length / 4) * 4, '=')
  return Buffer.from(base64, 'base64')
}

export function createSessionToken(user: SessionUser): string {
  const secret = process.env.AUTH_SECRET
  if (!secret) throw new Error('AUTH_SECRET is not configured')

  const payloadB64 = b64url(JSON.stringify(user))
  const sigBytes   = createHmac('sha256', secret).update(payloadB64).digest()
  return `${payloadB64}.${b64url(sigBytes)}`
}

export function verifySessionToken(token: string): SessionUser | null {
  try {
    const secret = process.env.AUTH_SECRET
    if (!secret) return null

    const dot = token.lastIndexOf('.')
    if (dot === -1) return null

    const payloadB64 = token.slice(0, dot)
    const sigB64     = token.slice(dot + 1)
    if (!payloadB64 || !sigB64) return null

    // Verify HMAC
    const expectedSig = createHmac('sha256', secret).update(payloadB64).digest()
    const actualSig   = b64urlDecode(sigB64)

    // Timing-safe compare
    if (expectedSig.length !== actualSig.length) return null
    let diff = 0
    for (let i = 0; i < expectedSig.length; i++) {
      diff |= expectedSig[i] ^ actualSig[i]
    }
    if (diff !== 0) return null

    // Decode payload
    const payloadText = b64urlDecode(payloadB64).toString('utf8')
    const payload = JSON.parse(payloadText) as SessionUser

    // Check expiry
    if (typeof payload.exp !== 'number') return null
    if (Math.floor(Date.now() / 1000) > payload.exp) return null

    return payload
  } catch {
    return null
  }
}

export function getSessionFromRequest(req: Request): SessionUser | null {
  try {
    const cookieHeader = req.headers.get('cookie') || ''
    // Parse cookie header manually (works in Edge and Node runtimes)
    const match = cookieHeader
      .split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('session='))
    if (!match) return null

    const token = match.slice('session='.length)
    if (!token) return null

    return verifySessionToken(token)
  } catch {
    return null
  }
}

// Also try reading from Next.js cookies() for Server Components / Route Handlers
export async function getSessionFromCookies(): Promise<SessionUser | null> {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get('session')?.value
    if (!token) return null
    return verifySessionToken(token)
  } catch {
    return null
  }
}
