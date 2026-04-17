import { NextRequest, NextResponse } from 'next/server'

// Exact-match list — avoids prefix leaks like /api/webhook/evolution-evil
const EXACT_PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/webhook/evolution', // self-authenticates via x-webhook-secret header
]

// Verify a signed session token produced by /api/auth/login.
// Format: {payload hex}.{HMAC-SHA256(AUTH_SECRET, payload) hex}
// Uses Web Crypto API — compatible with the Next.js Edge Runtime.
async function verifySessionToken(token: string, secret: string): Promise<boolean> {
  try {
    const dot = token.lastIndexOf('.')
    if (dot === -1) return false
    const payload = token.slice(0, dot)
    const sigHex  = token.slice(dot + 1)
    // HMAC-SHA256 digest is always 64 hex chars (32 bytes)
    if (!payload || sigHex.length !== 64) return false

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    )

    const pairs = sigHex.match(/.{2}/g)
    if (!pairs) return false
    const sigBytes = new Uint8Array(pairs.map(b => parseInt(b, 16)))

    return await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      new TextEncoder().encode(payload)
    )
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
    const loginUrl = req.nextUrl.clone()
    loginUrl.pathname = '/login'
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
