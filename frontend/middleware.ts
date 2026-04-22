import { NextRequest, NextResponse } from 'next/server'

// Auth temporarily disabled — pass all requests through
export function middleware(_req: NextRequest) {
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
