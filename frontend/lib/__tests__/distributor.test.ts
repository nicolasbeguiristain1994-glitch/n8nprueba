/**
 * distributor unit tests
 *
 * Coverage:
 *  1. scoreCandidate — component scores and total
 *  2. hardFilter     — eligibility gate
 *  3. intelligentAssign — scoring, ordering, advisory mode (no DB writes)
 *  4. Edge cases: no candidates, all filtered, proxy health variants
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  scoreCandidate,
  hardFilter,
  intelligentAssign,
  type CandidateLine,
} from '@/lib/distributor'

// ── Mock DB ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/db', () => ({
  query:           vi.fn(),
  withTransaction: vi.fn(),
}))
import * as db from '@/lib/db'
const mockQuery = vi.mocked(db.query)

// ── Factories ──────────────────────────────────────────────────────────────────

function makeLine(overrides: Partial<CandidateLine> = {}): CandidateLine {
  return {
    id:                    '00000000-0000-0000-0000-000000000001',
    line_key:              'line_01',
    display_name:          'Test Line 1',
    phone_number:          '+5491100000001',
    line_type:             'evolution',  // default: evolution (cloud lines are filtered out)
    evolution_instance:    'wa-instance-01',
    evolution_url:         'http://evolution:8080',
    status:                'active',
    is_connected:          true,
    sending_enabled:       true,
    msgs_sent_hour:        0,
    msgs_sent_today:       0,
    msg_per_hour:          50,
    msg_per_day:           500,
    priority:              1,
    last_seen_at:          null,
    assigned_region:       null,
    proxy_id:              null,
    last_proxy_rotated_at: null,
    last_assignment_score: null,
    avg_delivery_rate:     100,
    avg_error_rate:        0,
    proxy_health:          null,
    proxy_latency:         null,
    proxy_is_active:       null,
    ...overrides,
  }
}

// ── scoreCandidate ─────────────────────────────────────────────────────────────

describe('scoreCandidate', () => {
  it('perfect line → 100 points', () => {
    const line = makeLine({
      avg_delivery_rate: 100,
      msgs_sent_hour:    0,
      msgs_sent_today:   0,
      msg_per_hour:      50,
      msg_per_day:       500,
      priority:          1,
      proxy_health:      'healthy',
    })
    const s = scoreCandidate(line)
    expect(s.reputation).toBe(40)
    expect(s.capacity).toBe(25)
    expect(s.priority).toBe(15)
    expect(s.proxy_health).toBe(20)
    expect(s.total).toBe(100)
  })

  it('reputation: 50% delivery rate → 20pts', () => {
    const s = scoreCandidate(makeLine({ avg_delivery_rate: 50 }))
    expect(s.reputation).toBe(20)
  })

  it('capacity: half-full line → ~12pts', () => {
    const s = scoreCandidate(makeLine({
      msgs_sent_hour: 25, msg_per_hour: 50,
      msgs_sent_today: 250, msg_per_day: 500,
    }))
    expect(s.capacity).toBe(13)  // Math.round(0.5 * 25) = Math.round(12.5) = 13
  })

  it('capacity: fully consumed hour → 0pts regardless of day', () => {
    const s = scoreCandidate(makeLine({
      msgs_sent_hour: 50, msg_per_hour: 50,
      msgs_sent_today: 0,  msg_per_day: 500,
    }))
    expect(s.capacity).toBe(0)
  })

  it('priority 1 → 15pts, priority 4 → 6pts, priority 6 → 0pts', () => {
    expect(scoreCandidate(makeLine({ priority: 1 })).priority).toBe(15)
    expect(scoreCandidate(makeLine({ priority: 4 })).priority).toBe(6)
    expect(scoreCandidate(makeLine({ priority: 6 })).priority).toBe(0)
  })

  it('priority clamped at 0 for very high numbers', () => {
    expect(scoreCandidate(makeLine({ priority: 100 })).priority).toBe(0)
  })

  it('proxy_health: healthy=20, unknown=15, degraded=10, unhealthy=0', () => {
    expect(scoreCandidate(makeLine({ proxy_health: 'healthy'   })).proxy_health).toBe(20)
    expect(scoreCandidate(makeLine({ proxy_health: 'unknown'   })).proxy_health).toBe(15)
    expect(scoreCandidate(makeLine({ proxy_health: 'degraded'  })).proxy_health).toBe(10)
    expect(scoreCandidate(makeLine({ proxy_health: 'unhealthy' })).proxy_health).toBe(0)
  })

  it('no proxy (null) → 15pts for proxy_health', () => {
    expect(scoreCandidate(makeLine({ proxy_health: null })).proxy_health).toBe(15)
  })

  it('total is sum of components', () => {
    const s = scoreCandidate(makeLine({ avg_delivery_rate: 80, priority: 2, proxy_health: 'degraded' }))
    expect(s.total).toBe(s.reputation + s.capacity + s.priority + s.proxy_health)
  })
})

// ── hardFilter ─────────────────────────────────────────────────────────────────

describe('hardFilter', () => {
  it('passes a valid eligible line', () => {
    expect(hardFilter([makeLine()])).toHaveLength(1)
  })

  it('removes inactive status', () => {
    expect(hardFilter([makeLine({ status: 'inactive' })])).toHaveLength(0)
  })

  it('removes disconnected line', () => {
    expect(hardFilter([makeLine({ is_connected: false })])).toHaveLength(0)
  })

  it('removes sending_enabled=false', () => {
    expect(hardFilter([makeLine({ sending_enabled: false })])).toHaveLength(0)
  })

  it('removes hour-rate-limited line', () => {
    expect(hardFilter([makeLine({ msgs_sent_hour: 50, msg_per_hour: 50 })])).toHaveLength(0)
  })

  it('removes day-rate-limited line', () => {
    expect(hardFilter([makeLine({ msgs_sent_today: 500, msg_per_day: 500 })])).toHaveLength(0)
  })

  it('does NOT remove lines with unhealthy proxy — rotation handles that', () => {
    const line = makeLine({ proxy_health: 'unhealthy', proxy_is_active: true })
    expect(hardFilter([line])).toHaveLength(1)
  })

  it('empty input → empty output', () => {
    expect(hardFilter([])).toHaveLength(0)
  })

  // ── Cloud line exclusion ───────────────────────────────────────────────────

  it('removes cloud lines even when all other criteria pass', () => {
    const cloudLine = makeLine({
      line_type:          'cloud',
      evolution_instance: null,
      evolution_url:      null,
    })
    expect(hardFilter([cloudLine])).toHaveLength(0)
  })

  it('keeps evolution lines and removes cloud lines from a mixed fleet', () => {
    const evoLine   = makeLine({ id: 'evo-1', line_type: 'evolution' })
    const cloudLine = makeLine({ id: 'cloud-1', line_type: 'cloud', evolution_instance: null, evolution_url: null })
    const result = hardFilter([evoLine, cloudLine])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('evo-1')
  })

  it('a fully healthy cloud line is still excluded (cannot send via Evolution)', () => {
    const cloudLine = makeLine({
      line_type:          'cloud',
      evolution_instance: null,
      evolution_url:      null,
      status:             'active',
      is_connected:       true,
      sending_enabled:    true,
      msgs_sent_hour:     0,
      msgs_sent_today:    0,
    })
    expect(hardFilter([cloudLine])).toHaveLength(0)
  })
})

// ── intelligentAssign ──────────────────────────────────────────────────────────

describe('intelligentAssign', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns empty results when no candidate lines exist', async () => {
    mockQuery.mockResolvedValueOnce([])  // candidates query
    const res = await intelligentAssign()
    expect(res.results).toHaveLength(0)
    expect(res.totalCandidates).toBe(0)
    expect(res.filteredOut).toBe(0)
  })

  it('returns best scored line first', async () => {
    const lineA = makeLine({ id: 'aaa', priority: 1, avg_delivery_rate: 100, proxy_health: 'healthy' })
    const lineB = makeLine({ id: 'bbb', priority: 3, avg_delivery_rate: 60,  proxy_health: 'degraded' })
    mockQuery.mockResolvedValueOnce([lineA, lineB])  // candidates
    // proxyAction='none' for both → selectBestProxy called (returns null each time)
    mockQuery.mockResolvedValue([])  // selectBestProxy returns nothing

    const res = await intelligentAssign({ topN: 2 })
    expect(res.results).toHaveLength(2)
    expect(res.results[0].line.id).toBe('aaa')
    expect(res.results[0].score.total).toBeGreaterThan(res.results[1].score.total)
  })

  it('filters ineligible lines before scoring', async () => {
    const bad  = makeLine({ id: 'bad', status: 'inactive' })
    const good = makeLine({ id: 'good' })
    mockQuery.mockResolvedValueOnce([bad, good])
    mockQuery.mockResolvedValue([])

    const res = await intelligentAssign()
    expect(res.totalCandidates).toBe(2)
    expect(res.filteredOut).toBe(1)
    expect(res.results[0].line.id).toBe('good')
  })

  it('respects topN limit', async () => {
    const lines = ['a', 'b', 'c', 'd'].map(id => makeLine({ id }))
    mockQuery.mockResolvedValueOnce(lines)
    mockQuery.mockResolvedValue([])

    const res = await intelligentAssign({ topN: 2 })
    expect(res.results).toHaveLength(2)
  })

  it('sets proxyAction=keep when line has healthy proxy', async () => {
    const line = makeLine({
      id:              'line-1',
      proxy_id:        'proxy-1',
      proxy_health:    'healthy',
      proxy_is_active: true,
    })
    const proxyRow = { id: 'proxy-1', label: 'test', health_status: 'healthy' }
    mockQuery
      .mockResolvedValueOnce([line])      // candidates
      .mockResolvedValueOnce([proxyRow])  // SELECT * FROM proxies WHERE id = proxy_id

    const res = await intelligentAssign()
    expect(res.results[0].proxyAction).toBe('keep')
    expect(res.results[0].proxy?.id).toBe('proxy-1')
  })

  it('sets proxyAction=replace when line has unhealthy proxy', async () => {
    const line = makeLine({
      id:              'line-1',
      proxy_id:        'old-proxy',
      proxy_health:    'unhealthy',
      proxy_is_active: true,
    })
    const newProxy = { id: 'new-proxy', label: 'replacement', health_status: 'healthy' }
    mockQuery
      .mockResolvedValueOnce([line])       // candidates
      .mockResolvedValueOnce([newProxy])   // selectBestProxy result

    const res = await intelligentAssign()
    expect(res.results[0].proxyAction).toBe('replace')
    expect(res.results[0].proxy?.id).toBe('new-proxy')
  })

  it('persist=false does not call UPDATE queries', async () => {
    const line = makeLine()
    mockQuery
      .mockResolvedValueOnce([line])  // candidates
      .mockResolvedValue([])          // selectBestProxy

    await intelligentAssign({ persist: false })

    // Only the candidates query and the selectBestProxy query should have been called
    // UPDATE whatsapp_lines should NOT be called
    const calls = mockQuery.mock.calls.map(c => String(c[0]))
    expect(calls.every(sql => !sql.includes('UPDATE'))).toBe(true)
  })
})
