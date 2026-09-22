// @vitest-environment node
/**
 * casino-sync-status-route.test.ts
 *
 * GET /api/dashboard/casino/sync-status (fase 4): último estado por
 * (platform, agente) leído de casino_sync_runs, sin dejar que un 'skipped'
 * tape el último éxito/error real, mostrando agentes configurados sin
 * historial (nunca omitidos en silencio), con lastSuccessfulAt aparte del
 * estado actual, y con un error claro (por código 42P01, no por texto) si
 * la migración 128 no se aplicó.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/permissions', () => ({ checkPermission: vi.fn().mockResolvedValue(undefined) }))
const queryMock = vi.fn()
vi.mock('@/lib/db', () => ({ query: (...args: unknown[]) => queryMock(...args) }))

import { GET } from '@/app/api/dashboard/casino/sync-status/route'

// Query order in the route: latestPerAgent, lastSuccessPerAgent, skipRuns, latestParentPerPlatform
function mockQueries({
  latestPerAgent = [] as unknown[],
  lastSuccessPerAgent = [] as unknown[],
  skipRuns = [] as unknown[],
  parentRuns = [] as unknown[],
} = {}) {
  queryMock
    .mockResolvedValueOnce(latestPerAgent)
    .mockResolvedValueOnce(lastSuccessPerAgent)
    .mockResolvedValueOnce(skipRuns)
    .mockResolvedValueOnce(parentRuns)
}

describe('GET /api/dashboard/casino/sync-status', () => {
  beforeEach(() => queryMock.mockReset())

  it('returns every configured agent for the 4 sync platforms, even ones with no run at all', async () => {
    mockQueries({
      latestPerAgent: [
        { platform: 'zeus', agente: 'betcoin', status: 'ok', started_at: 't1', finished_at: 't2', tx_inserted: 5, error: null },
      ],
    })

    const res = await GET(new Request('http://x/api/dashboard/casino/sync-status'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(Object.keys(body.platforms)).toEqual(['zeus', 'bet30', 'ganamos', 'argenbet'])

    const zeusAgentNames = body.platforms.zeus.agents.map((a: { agente: string }) => a.agente)
    expect(zeusAgentNames).toContain('betcoin')
    expect(zeusAgentNames).toContain('royal') // configured but never synced — must still appear

    const betcoin = body.platforms.zeus.agents.find((a: { agente: string }) => a.agente === 'betcoin')
    expect(betcoin).toMatchObject({ status: 'ok', txInserted: 5 })

    const royal = body.platforms.zeus.agents.find((a: { agente: string }) => a.agente === 'royal')
    expect(royal.status).toBe('never_synced')
  })

  it('a skip does not hide the last real ok/failed status — it is reported separately as lastSkipAt', async () => {
    mockQueries({
      latestPerAgent: [
        { platform: 'ganamos', agente: 'adminroyal', status: 'ok', started_at: 't1', finished_at: 't2', tx_inserted: 2, error: null },
      ],
      skipRuns: [{ platform: 'ganamos', started_at: 't3' }],
    })

    const res = await GET(new Request('http://x/api/dashboard/casino/sync-status'))
    const body = await res.json()

    const adminroyal = body.platforms.ganamos.agents.find((a: { agente: string }) => a.agente === 'adminroyal')
    expect(adminroyal.status).toBe('ok') // not overwritten by the skip
    expect(body.platforms.ganamos.lastSkipAt).toBe('t3')
  })

  it('lastSuccessfulAt survives even when the agent is currently failed — the last real success is not lost', async () => {
    mockQueries({
      latestPerAgent: [
        { platform: 'zeus', agente: 'betcoin', status: 'failed', started_at: 't3', finished_at: 't3', tx_inserted: null, error: 'HTTP 401' },
      ],
      lastSuccessPerAgent: [{ platform: 'zeus', agente: 'betcoin', finished_at: 't1-ok' }],
    })

    const res = await GET(new Request('http://x/api/dashboard/casino/sync-status'))
    const body = await res.json()

    const betcoin = body.platforms.zeus.agents.find((a: { agente: string }) => a.agente === 'betcoin')
    expect(betcoin.status).toBe('failed')
    expect(betcoin.lastSuccessfulAt).toBe('t1-ok')
  })

  it('exposes the platform-level parent run separately from the per-agent list', async () => {
    mockQueries({
      parentRuns: [{ platform: 'zeus', agente: null, status: 'running', started_at: 't1', finished_at: null, tx_inserted: null, error: null }],
    })

    const res = await GET(new Request('http://x/api/dashboard/casino/sync-status'))
    const body = await res.json()

    expect(body.platforms.zeus.platformRun).toMatchObject({ status: 'running' })
    expect(body.platforms.zeus.agents.every((a: { agente: string }) => a.agente !== null)).toBe(true)
  })

  it('returns a clear 503 (not a generic 500), detected by Postgres error CODE 42P01, when casino_sync_runs does not exist yet', async () => {
    const err = Object.assign(new Error('relation "casino_sync_runs" does not exist'), { code: '42P01' })
    queryMock.mockRejectedValueOnce(err)

    const res = await GET(new Request('http://x/api/dashboard/casino/sync-status'))
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body.error).toContain('128_casino_sync_runs.sql')
  })

  it('a query error whose MESSAGE merely mentions casino_sync_runs, but has a different code, is NOT reported as a missing table', async () => {
    const err = Object.assign(new Error('permission denied for table casino_sync_runs'), { code: '42501' })
    queryMock.mockRejectedValueOnce(err)

    const res = await GET(new Request('http://x/api/dashboard/casino/sync-status'))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).not.toContain('128_casino_sync_runs.sql')
  })
})
