// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from '../../middleware'

vi.mock('@/lib/auth', () => ({ getSessionFromRequest: vi.fn(() => null) }))

afterEach(() => vi.unstubAllEnvs())

describe('login Content Security Policy', () => {
  it.each(['development', 'production'] as const)(
    'forwards the same nonce to the renderer and browser in %s',
    (mode) => {
      vi.stubEnv('NODE_ENV', mode)
      const response = middleware(new NextRequest('http://localhost:3000/login'))
      const csp = response.headers.get('Content-Security-Policy')!
      const nonce = response.headers.get('x-middleware-request-x-nonce')!
      expect(nonce).toBeTruthy()
      expect(csp).toContain(`'nonce-${nonce}'`)
      expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(csp)
      expect(csp.includes("'unsafe-eval'")).toBe(mode === 'development')
      expect(csp.split(';').find(directive => directive.trim().startsWith('script-src'))).not.toContain("'unsafe-inline'")
      const nextResponse = middleware(new NextRequest('http://localhost:3000/login'))
      expect(nextResponse.headers.get('x-middleware-request-x-nonce')).not.toBe(nonce)
    },
  )
})

describe('internal cron authentication', () => {
  it.each(['/api/contacts/recompute-priorities', '/api/cron/campaigns'])('accepts the existing cron credential only for exact POST %s', (path) => {
    vi.stubEnv('CRON_SECRET', 'test-secret')
    const request = (path: string, method = 'POST', value = 'test-secret') => new NextRequest(`http://localhost:3000${path}`, { method, headers: { 'x-cron-secret': value } })
    expect(middleware(request(path)).headers.get('x-middleware-next')).toBe('1')
    expect(middleware(request(path, 'GET')).status).toBe(401)
    expect(middleware(request(path + '/other')).status).toBe(401)
    expect(middleware(request(path, 'POST', 'wrong')).status).toBe(401)
    expect(middleware(request('/api/contacts')).status).toBe(401)
  })
})
