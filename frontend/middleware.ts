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
import { randomBytes } from 'node:crypto'
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
  '/api/cloud/sync',
  // Internal cron/worker endpoints — protected by WARMUP_PROCESS_SECRET
  '/api/warmup/process',
  '/api/warmup/schedule',
  '/api/warmup/daily-reset',
  '/api/warmup/orchestrator/run',
  '/api/warmup/conversations/process',
]

const UNPROTECTED_PAGES: readonly string[] = [
  '/',
  '/login',
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
 * script-src: nonce-only — 'unsafe-inline' and 'unsafe-eval' removed.
 *   Next.js 16 App Router does not generate inline <script> tags in production;
 *   RSC payloads travel as streaming JSON, not embedded scripts.
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
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' wss: https:",
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

  const passThrough = (): NextResponse => {
    const res = NextResponse.next({ request: { headers: requestHeaders } })
    return applySecurityHeaders(res, nonce)
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
