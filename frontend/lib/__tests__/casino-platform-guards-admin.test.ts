// @vitest-environment node
/**
 * casino-platform-guards-admin.test.ts
 *
 * Regression tests for the coordinator's mensaje 8 (2026-09-21):
 *   - /api/admin/fix-platforms and /api/contacts/recompute-platforms matched
 *     contacts to casino_players by `agente = ANY(lista)` alone. 'bigwin' is
 *     an agent of BOTH zeus and bet30, so a bet30 'bigwin' player could be
 *     tagged as zeus (or vice versa) without an explicit `platform` filter.
 *   - /api/admin/migrate replays pre-127 legacy steps (110a-115a) that assume
 *     a single global username_lower identity; once migration 127's index
 *     exists they must be skipped with a clear message instead of silently
 *     mixing platforms.
 *
 * These are string-level checks against the generated SQL (no real Postgres
 * available in this sandbox) — they verify the platform guard is present in
 * every query that touches casino_players via agente-list matching.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const queries: string[] = []
const fakeClient = {
  query: vi.fn(async (sql: string) => { queries.push(sql); return { rowCount: 0 } }),
  end:   vi.fn(async () => {}),
}
const queryMock = vi.fn(async (sql: string): Promise<Record<string, unknown>[]> => {
  queries.push(sql)
  return [{ exists: false }]
})

vi.mock('@/lib/db', () => ({
  getLongRunningClient: vi.fn(async () => fakeClient),
  query: (...args: unknown[]) => queryMock(...(args as [string])),
}))
vi.mock('@/lib/permissions', () => ({ checkPermission: vi.fn() }))

function req(url: string) {
  return new NextRequest(new Request(url, { method: 'POST' }))
}

describe('admin/fix-platforms — explicit platform guard', () => {
  beforeEach(() => { queries.length = 0; vi.clearAllMocks() })

  it('every casino_players lookup requires cp.platform explicitly', async () => {
    const { POST } = await import('@/app/api/admin/fix-platforms/route')
    await POST(req('http://x/api/admin/fix-platforms'))
    // runFixPlatforms() runs detached (void) — wait a tick for it to execute.
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    const casinoPlayersQueries = queries.filter(q => q.includes('casino_players cp'))
    expect(casinoPlayersQueries.length).toBeGreaterThan(0)
    for (const q of casinoPlayersQueries) {
      expect(q).toMatch(/cp\.platform\s*=\s*'(zeus|bet30)'/)
    }
  })
})

describe('contacts/recompute-platforms — explicit platform guard', () => {
  beforeEach(() => {
    queries.length = 0
    vi.clearAllMocks()
    queryMock.mockImplementation(async (sql: string) => { queries.push(sql); return [{ updated: '0' }] })
  })

  it('the casino_players EXISTS subquery requires cp.platform = zeus', async () => {
    const { POST } = await import('@/app/api/contacts/recompute-platforms/route')
    await POST(req('http://x/api/contacts/recompute-platforms'))

    expect(queries.length).toBe(1)
    expect(queries[0]).toContain("cp.platform = 'zeus'")
  })
})

describe('admin/migrate — skips legacy pre-127 steps when migration 127 is applied', () => {
  beforeEach(() => { queries.length = 0; vi.clearAllMocks() })

  it('reports 110a as a clear skip instead of running it, when the 127 index exists', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      queries.push(sql)
      if (sql.includes('idx_casino_players_platform_username')) return [{ exists: true }]
      return []
    })
    const { POST } = await import('@/app/api/admin/migrate/route')
    const res = await POST(req('http://x/api/admin/migrate'))
    const body = await res.json()

    const step110a = body.results.find((r: { step: string }) => r.step.startsWith('110a'))
    expect(step110a.ok).toBe(false)
    expect(step110a.error).toContain('Migración 127')

    // The legacy step's SQL must never have been sent to the DB.
    expect(queries.some(q => q.includes('recalculate casino_players seg_actividad'))).toBe(false)
    expect(queries.some(q => q.includes('active_months'))).toBe(false)
  })

  it('runs 110a normally when migration 127 has not been applied yet', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      queries.push(sql)
      if (sql.includes('idx_casino_players_platform_username')) return [{ exists: false }]
      return []
    })
    const { POST } = await import('@/app/api/admin/migrate/route')
    const res = await POST(req('http://x/api/admin/migrate'))
    const body = await res.json()

    const step110a = body.results.find((r: { step: string }) => r.step.startsWith('110a'))
    expect(step110a.ok).toBe(true)
    expect(queries.some(q => q.includes('active_months'))).toBe(true)
  })
})
