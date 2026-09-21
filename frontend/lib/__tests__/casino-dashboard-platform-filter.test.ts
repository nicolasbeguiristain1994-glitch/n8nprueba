// @vitest-environment node
/**
 * casino-dashboard-platform-filter.test.ts
 *
 * H3 regression: /api/dashboard/casino, /players and /risk used to filter
 * casino_players/casino_transactions by `agente = ANY(lista_de_agentes)` as a
 * proxy for platform — which mixed platforms whenever an agent name is shared
 * (e.g. 'bigwin' is an agent in both zeus and bet30). They must now filter
 * STRICTLY by the `platform` column.
 *
 * A first version of the fix fell back to
 * `OR (platform IS NULL AND agente = ANY(legacyAgents))` for un-backfilled
 * legacy rows — but that reintroduced the exact bug it was meant to fix: an
 * ambiguous agent like 'bigwin' (deliberately left `platform IS NULL` by
 * migration 127, since it exists in both zeus and bet30) would then match
 * BOTH platforms' fallback clause and get double-counted. The filter must
 * never guess a platform for an ambiguous historical row — those are excluded
 * from every platform-specific view.
 *
 * These tests don't execute real SQL — they assert the query text sent to
 * `query()` contains a strict platform match and NEVER an agent-list fallback.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({ query: vi.fn().mockResolvedValue([]) }))
vi.mock('@/lib/permissions', () => ({ checkPermission: vi.fn() }))

import * as db          from '@/lib/db'
import * as permissions from '@/lib/permissions'
import { GET as GetSummary } from '@/app/api/dashboard/casino/route'
import { GET as GetPlayers } from '@/app/api/dashboard/casino/players/route'
import { GET as GetRisk }    from '@/app/api/dashboard/casino/risk/route'

function req(url: string) {
  return new NextRequest(new Request(url))
}

function allSql(): string[] {
  return vi.mocked(db.query).mock.calls.map(c => String(c[0]))
}

beforeEach(() => {
  vi.mocked(permissions.checkPermission).mockResolvedValue(undefined as never)
  vi.mocked(db.query).mockClear()
  vi.mocked(db.query).mockResolvedValue([])
})

describe('GET /api/dashboard/casino — platform filter (H3)', () => {
  it('every casino_players query filters strictly by platform — no ambiguous-agent fallback', async () => {
    await GetSummary(req('http://x/api/dashboard/casino?platform=bet30'))
    const queries = allSql().filter(q => q.includes('FROM casino_players'))
    expect(queries.length).toBeGreaterThan(0)
    for (const sql of queries) {
      expect(sql).toContain("platform = 'bet30'")
      expect(sql).not.toContain('platform IS NULL') // no fallback to ambiguous agents like bigwin
    }
  })

  it('consolidado includes all 4 sync platforms, not just zeus/bet30', async () => {
    await GetSummary(req('http://x/api/dashboard/casino?platform=consolidado'))
    const queries = allSql().filter(q => q.includes('FROM casino_players'))
    expect(queries.length).toBeGreaterThan(0)
    for (const sql of queries) {
      expect(sql).toMatch(/platform\s*=\s*ANY\('\{zeus,bet30,ganamos,argenbet\}'::text\[\]\)/)
    }
  })
})

describe('GET /api/dashboard/casino/players — platform filter (H3)', () => {
  it('historical mode filters casino_players by platform', async () => {
    await GetPlayers(req('http://x/api/dashboard/casino/players?platform=zeus'))
    const queries = allSql().filter(q => q.includes('FROM casino_players'))
    expect(queries.length).toBeGreaterThan(0)
    for (const sql of queries) expect(sql).toContain("platform = 'zeus'")
  })

  it('period mode filters casino_transactions by platform (aliased ct)', async () => {
    await GetPlayers(req('http://x/api/dashboard/casino/players?platform=zeus&fecha_desde=2025-01-01&fecha_hasta=2025-01-31'))
    const queries = allSql().filter(q => q.includes('FROM casino_transactions ct'))
    expect(queries.length).toBeGreaterThan(0)
    for (const sql of queries) expect(sql).toContain("ct.platform = 'zeus'")
  })
})

describe('GET /api/dashboard/casino/risk — platform filter (H3)', () => {
  it('filters every casino_players query by platform', async () => {
    await GetRisk(req('http://x/api/dashboard/casino/risk?platform=argenbet'))
    const queries = allSql().filter(q => q.includes('FROM casino_players'))
    expect(queries.length).toBeGreaterThan(0)
    for (const sql of queries) expect(sql).toContain("platform = 'argenbet'")
  })
})
