import { NextRequest, NextResponse } from 'next/server'

// Exact-match list — avoids prefix leaks like /api/webhook/evolution-evil
const EXACT_PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/webhook/evolution', // self-authenticates via x-webhook-secret header
]

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Dejar pasar rutas públicas y assets
  if (
    EXACT_PUBLIC_PATHS.includes(pathname) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon')
  ) {
    return NextResponse.next()
  }

  const token = req.cookies.get('auth_token')?.value
  const expected = process.env.AUTH_SECRET

  if (!expected || token !== expected) {
    const loginUrl = req.nextUrl.clone()
    loginUrl.pathname = '/login'
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
