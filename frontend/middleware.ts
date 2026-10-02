/**
 * Next.js middleware — authentication gate + security headers.
 *
 * Runs on every non-static request. Two responsibilities:
 *   1. Verify the session cookie and redirect/reject unauthenticated requests.
 *   2. Generate a per-request CSP nonce and attach security headers.
 *
 * Runtime: Node.js (required to reuse lib/auth.ts which uses node:crypto).
 */

export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { getSessionFromRequest } from '@/lib/auth'

// ── Route classification ──────────────────────────────────────────────────────

/**
 * API routes that handle their own authentication and must not be blocked
 * by the session check. Add entries here only when the route verifies its
 * own credentials (HMAC signature, shared secret, etc.).
 */
const UNPROTECTED_API_PREFIXES: readonly string[] = [
  '/api/auth/login',
  '/api/auth/logout',
  // OAuth callbacks — validate code+state internally
  '/api/auth/callback/',
  // Webhook receivers — verified via HMAC / Meta challenge internally
  '/api/webhook/',
  '/api/cloud/webhook',
]

const UNPROTECTED_PAGES: readonly string[] = [
  '/',
  '/login',
  '/release.json', // generated from the validated Git artifact; no secrets
  '/politica-de-privacidad',
  '/terminos-y-condiciones',
  '/eliminacion-de-datos',
  // OAuth / webhook page-level routes
  '/auth/facebook/callback',
  '/webhook/meta',
]

function isUnprotected(pathname: string): boolean {
  if (UNPROTECTED_PAGES.includes(pathname)) return true
  return UNPROTECTED_API_PREFIXES.some(prefix => pathname.startsWith(prefix))
}

// ── CSP + Security headers ────────────────────────────────────────────────────

/**
 * Phase 2: CSP in enforcement mode with per-request nonces.
 *
 * script-src: framework and inline scripts use a per-request nonce.
 *   Development also needs eval for the Next.js development runtime.
 *   Production never enables unsafe-eval.
 *
 * style-src: 'unsafe-inline' kept — Tailwind generates inline utility classes
 *   that cannot be nonce'd without a build-time CSS extraction step.
 *
 * font-src: https://fonts.gstatic.com added for the Inter font loaded via
 *   Google Fonts <link> in layout.tsx.
 *
 * Future: replace the Google Fonts <link> with next/font to remove the
 *   external font dependency and eliminate the fonts.gstatic.com allowance.
 */
function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV === 'development'
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' wss: https:",
    "frame-src 'self' https://www.facebook.com https://web.facebook.com",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ')
}

function applySecurityHeaders(res: NextResponse, nonce: string): NextResponse {
  res.headers.set('X-Content-Type-Options', 'nosniff')
  res.headers.set('X-Frame-Options', 'DENY')
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.headers.set('X-Permitted-Cross-Domain-Policies', 'none')
  res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.headers.set('Content-Security-Policy', buildCsp(nonce))
  // Fuerza HTTPS por un año e incluye subdominios. Preload omitido intencionalmente
  // hasta confirmar que todos los subdominios soportan HTTPS.
  res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  // Aísla el contexto de ventana del navegador ante ataques Spectre/XS-Leaks.
  res.headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  // Bloquea la carga de este origen como recurso desde contextos cross-origin.
  res.headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  return res
}

// ── Middleware ────────────────────────────────────────────────────────────────

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl

  // 128-bit cryptographically random nonce, generated fresh per request.
  // Forwarded to Server Components via x-nonce so layout.tsx can apply it
  // to inline <style> tags without needing 'unsafe-inline' on scripts.
  const nonce = randomBytes(16).toString('base64')

  const requestHeaders = new Headers(req.headers)
  requestHeaders.set('x-nonce', nonce)
  // Next.js reads the request CSP to nonce its generated scripts.
  requestHeaders.set('Content-Security-Policy', buildCsp(nonce))

  const passThrough = (): NextResponse => {
    const res = NextResponse.next({ request: { headers: requestHeaders } })
    return applySecurityHeaders(res, nonce)
  }

  // Retired module: reject stale tabs and cron calls before any handler executes.
  if (pathname === '/api/anti-ban-profiles' || pathname === '/api/warmup' || pathname.startsWith('/api/warmup/')) {
    return applySecurityHeaders(NextResponse.json(
      { error: 'El módulo de calentamiento fue retirado', code: 'MODULE_RETIRED' },
      { status: 410, headers: { 'Cache-Control': 'no-store' } },
    ), nonce)
  }

  // This endpoint already accepts CRON_SECRET; recognize the same credential
  // here without bypassing sessions for any other path or method.
  const cronSecret = process.env.CRON_SECRET
  const suppliedSecret = req.headers.get('x-cron-secret')
  if (['/api/contacts/recompute-priorities', '/api/cron/campaigns'].includes(pathname) && req.method === 'POST' && cronSecret && suppliedSecret) {
    const expected = Buffer.from(cronSecret), supplied = Buffer.from(suppliedSecret)
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) return passThrough()
  }

  if (isUnprotected(pathname)) return passThrough()

  const session = getSessionFromRequest(req)

  if (!session) {
    if (pathname.startsWith('/api/')) {
      // API consumers get a JSON 401 — they cannot follow a redirect.
      const res = NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      return applySecurityHeaders(res, nonce)
    }

    // Browser requests get redirected to the login page.
    const loginUrl = new URL('/login', req.url)
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  return passThrough()
}

export const config = {
  matcher: [
    /*
     * Run on every path except:
     *   - Next.js static chunk serving (_next/static, _next/image)
     *   - Static file extensions served from /public
     */
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
