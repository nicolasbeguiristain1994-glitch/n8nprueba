// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from '../../middleware'
import { canAccess, effectivePermissions } from '@/lib/permissions'
import { getSessionFromRequest } from '@/lib/auth'

vi.mock('@/lib/auth', () => ({ getSessionFromRequest: vi.fn(() => null) }))
vi.mock('@/lib/db', () => ({ query: vi.fn() }))
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('retired warmup module', () => {
  it.each([
    ['/api/anti-ban-profiles', 'GET'], ['/api/warmup', 'GET'], ['/api/warmup', 'POST'],
    ['/api/warmup/process', 'POST'], ['/api/warmup/schedule', 'POST'],
    ['/api/warmup/daily-reset', 'POST'], ['/api/warmup/orchestrator/run', 'POST'],
    ['/api/warmup/conversations/process', 'POST'], ['/api/warmup/stream', 'GET'],
    ['/api/warmup/example', 'PATCH'], ['/api/warmup/example', 'DELETE'],
  ])('rejects %s %s before running a worker or checking sessions', async (path, method) => {
    vi.stubEnv('WARMUP_PROCESS_SECRET', 'former-worker-secret')
    const response = middleware(new NextRequest('http://localhost:3000' + path, {
      method, headers: { 'x-warmup-secret': 'former-worker-secret' },
    }))
    expect(response.status).toBe(410)
    expect(await response.json()).toMatchObject({ code: 'MODULE_RETIRED' })
    expect(response.headers.get('x-middleware-next')).toBeNull()
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(getSessionFromRequest).not.toHaveBeenCalled()
  })

  it.each(['admin', 'operator', 'viewer'] as const)('does not grant %s legacy warmup access', role => {
    const user = { role, sectors: ['warmup', 'lines'] }
    for (const action of ['read', 'create', 'update', 'delete', 'manage', 'send'] as const) {
      expect(canAccess(user, 'warmup', action)).toBe(false)
    }
    expect(effectivePermissions(user).warmup).toBeUndefined()
    expect(canAccess(user, 'lines', 'read')).toBe(true)
  })

  it('leaves campaign workers and Cloud webhook routing available', () => {
    vi.stubEnv('CRON_SECRET', 'campaign-secret')
    const campaign = middleware(new NextRequest('http://localhost:3000/api/cron/campaigns', {
      method: 'POST', headers: { 'x-cron-secret': 'campaign-secret' },
    }))
    expect(campaign.headers.get('x-middleware-next')).toBe('1')
    expect(middleware(new NextRequest('http://localhost:3000/api/cloud/webhook')).headers.get('x-middleware-next')).toBe('1')
    expect(middleware(new NextRequest('http://localhost:3000/api/warmup-other')).status).toBe(401)
  })
})
