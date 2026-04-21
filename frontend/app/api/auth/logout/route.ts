import { NextResponse } from 'next/server'

export async function POST() {
  const res = NextResponse.json({ ok: true })
  const clearOpts = {
    maxAge:   0,
    httpOnly: true,
    sameSite: 'lax' as const,
    path:     '/',
    secure:   process.env.NODE_ENV === 'production',
  }
  // Clear both cookie names for backwards compatibility
  res.cookies.set('session',    '', clearOpts)
  res.cookies.set('auth_token', '', clearOpts)
  return res
}
