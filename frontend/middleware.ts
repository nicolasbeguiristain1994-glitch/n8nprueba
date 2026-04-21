import { NextRequest, NextResponse } from 'next/server'

// Exact-match list — avoids prefix leaks like /api/webhook/evolution-evil
const EXACT_PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/webhook/evolution', // self-authenticates via x-webhook-secret header
]

// ── base64url decoder (Edge / Web Crypto compatible) ─────────────────────
// Returns ArrayBuffer so it satisfies BufferSource directly (no Uint8Array
// generic variance issues with TypeScript 5's Uint8Array<TArrayBuffer> types).
function b64urlDecode(s: string): ArrayBuffer {
  const base64 = s
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(s.length / 4) * 4, '=')
  const binary = atob(base64)
  const buf    = new ArrayBuffer(binary.length)
  const view   = new Uint8Array(buf)
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i)
  return buf
}

// Verify a signed session token produced by /api/auth/login.
// Format: base64url(payloadJson).base64url(hmacSha256Bytes)
// Checks: valid base64url structure → HMAC integrity → exp not in the past.
// Uses Web Crypto API — compatible with the Next.js Edge Runtime.
async function verifySessionToken(token: string, secret: string): Promise<boolean> {
  try {
    const dot = token.lastIndexOf('.')
    if (dot === -1) return false
    const payloadB64 = token.slice(0, dot)
    const sigB64     = token.slice(dot + 1)
    if (!payloadB64 || !sigB64) return false

    // ── 1. Verify HMAC first (timing-safe) ──────────────────────────────────
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      b64urlDecode(sigB64),
      new TextEncoder().encode(payloadB64)
    )
    if (!valid) return false

    // ── 2. Decode payload and check expiry ───────────────────────────────────
    const payloadText = new TextDecoder().decode(b64urlDecode(payloadB64))
    const payload = JSON.parse(payloadText) as Record<string, unknown>
    if (typeof payload.exp !== 'number') return false
    if (Math.floor(Date.now() / 1000) > payload.exp) return false

    return true
  } catch {
    return false
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (
    EXACT_PUBLIC_PATHS.includes(pathname) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon')
  ) {
    return NextResponse.next()
  }

  const token  = req.cookies.get('auth_token')?.value
  const secret = process.env.AUTH_SECRET

  if (!secret || !token || !(await verifySessionToken(token, secret))) {
    if (pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const loginUrl = req.nextUrl.clone()
    loginUrl.pathname = '/login'
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
