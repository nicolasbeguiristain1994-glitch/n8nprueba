'use strict'

const {
  resolveIncrementalRange,
  AUTO_BOOTSTRAP_DESDE,
  GANAMOS_RETENTION_DAYS,
} = require('../../src/casino-connectors/shared/incrementalWindow')

function makePool({ lastTxByKey = {}, lastFechaByAgente = {}, syncRunsByKey = {} } = {}) {
  return {
    query: jest.fn(async (sql, params) => {
      if (sql.includes('MAX(fecha_hora_utc)')) {
        const [platform, agente] = params
        return { rows: [{ last: lastTxByKey[`${platform}:${agente}`] ?? null }] }
      }
      if (sql.includes("MAX(fecha) AS last_fecha")) {
        const [agente] = params
        return { rows: [{ last_fecha: lastFechaByAgente[agente] ?? null }] }
      }
      if (sql.includes('FROM casino_sync_runs')) {
        const [platform, agente] = params
        return { rows: syncRunsByKey[`${platform}:${agente}`] ?? [] }
      }
      throw new Error(`unexpected query: ${sql}`)
    }),
  }
}

function runRow({ status, desde, hasta, startedAt }) {
  return { status, range_desde: desde, range_hasta: hasta, started_at: startedAt }
}

describe('resolveIncrementalRange (D4/H7, per-agent watermark)', () => {
  it('computes desde as MAX(fecha_hora_utc) - 30min, scoped to (platform, agente)', async () => {
    const pool = makePool({ lastTxByKey: { 'zeus:betcoin': '2026-09-01T10:00:00.000Z' } })
    const { desde, hasta, mode } = await resolveIncrementalRange(pool, 'zeus', 'betcoin', { now: new Date('2026-09-01T12:00:00.000Z') })

    expect(mode).toBe('incremental')
    expect(desde).toBe('2026-09-01T09:30:00.000Z')
    expect(hasta).toBe('2026-09-01T12:00:00.000Z')
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE platform = $1 AND agente = $2'), ['zeus', 'betcoin'])
  })

  it('bootstraps from the documented per-platform default when the agent has no prior data', async () => {
    const pool = makePool()
    const { desde, mode } = await resolveIncrementalRange(pool, 'zeus', 'nuevo-agente', { now: new Date('2026-09-01T12:00:00.000Z') })
    expect(mode).toBe('bootstrap')
    expect(desde).toBe(AUTO_BOOTSTRAP_DESDE.zeus)
    expect(desde).not.toBe('2020-01-01') // must not silently reuse the old global default
  })

  it('never lets agent B\'s success advance agent A\'s checkpoint (partial-failure safety)', async () => {
    const pool = makePool({
      lastTxByKey: {
        'zeus:agentA': '2026-09-01T08:00:00.000Z',
        'zeus:agentB': '2026-09-05T08:00:00.000Z',
      },
    })
    const now = new Date('2026-09-06T00:00:00.000Z')
    const a = await resolveIncrementalRange(pool, 'zeus', 'agentA', { now })
    const b = await resolveIncrementalRange(pool, 'zeus', 'agentB', { now })

    expect(a.desde).toBe('2026-09-01T07:30:00.000Z')
    expect(b.desde).toBe('2026-09-05T07:30:00.000Z')
    expect(a.desde).not.toBe(b.desde)
  })

  it('a day with no transactions does not lose the checkpoint (desde stays anchored to the last real MAX, not "today")', async () => {
    const pool = makePool({ lastTxByKey: { 'zeus:royal': '2026-08-20T10:00:00.000Z' } })
    const now = new Date('2026-08-25T10:00:00.000Z') // 5 days with nothing new
    const { desde } = await resolveIncrementalRange(pool, 'zeus', 'royal', { now })
    expect(desde).toBe('2026-08-20T09:30:00.000Z') // still anchored to the last known transaction, not to `now`
  })

  // ── Ganamos ────────────────────────────────────────────────────────────────

  describe('ganamos', () => {
    it('uses the Argentina LOCAL calendar day, not the UTC day, near ART midnight', async () => {
      const pool = makePool({ lastFechaByAgente: { adminroyal: '2026-09-21' } })
      // 2026-09-22T01:00:00Z is still 2026-09-21 in Argentina (UTC-3).
      const now = new Date('2026-09-22T01:00:00.000Z')
      const { desde, hasta, mode } = await resolveIncrementalRange(pool, 'ganamos', 'adminroyal', { now })

      expect(hasta).toBe('2026-09-21')
      expect(desde).toBe('2026-09-21')
      expect(mode).toBe('ganamos-current-day')
    })

    it('bootstraps to "today only" when the agent has no committed data at all (never infers history)', async () => {
      const pool = makePool()
      const now = new Date('2026-09-22T15:00:00.000Z')
      const { desde, hasta, mode } = await resolveIncrementalRange(pool, 'ganamos', 'nuevo-agente', { now })
      expect(desde).toBe('2026-09-22')
      expect(hasta).toBe('2026-09-22')
      expect(mode).toBe('ganamos-current-day')
    })

    it('recovers day-by-day from the last committed day forward when a run was missed (does not jump straight to today)', async () => {
      const pool = makePool({ lastFechaByAgente: { adminroyal: '2026-09-18' } })
      const now = new Date('2026-09-22T12:00:00.000Z')
      const { desde, hasta, mode, staleDays } = await resolveIncrementalRange(pool, 'ganamos', 'adminroyal', { now })

      expect(desde).toBe('2026-09-18') // re-includes the last known day (may have been partial)
      expect(hasta).toBe('2026-09-22')
      expect(mode).toBe('ganamos-catchup')
      expect(staleDays).toBeNull() // 4-day gap, below the 7-day warn threshold
    })

    it('warns (staleDays set) when the catch-up gap exceeds 7 days but is still within the 60-day retention window', async () => {
      const log = { warn: jest.fn() }
      const pool = makePool({ lastFechaByAgente: { adminroyal: '2026-09-01' } })
      const now = new Date('2026-09-15T12:00:00.000Z') // 14-day gap
      const { desde, staleDays, retentionCapped } = await resolveIncrementalRange(pool, 'ganamos', 'adminroyal', { now, log })

      expect(desde).toBe('2026-09-01')
      expect(staleDays).toBe(14)
      expect(retentionCapped).toBe(false)
      expect(log.warn).toHaveBeenCalledTimes(1)
    })

    it('caps the window at the 60-day retention boundary and warns explicitly when the gap is unrecoverable — never a silent truncation', async () => {
      const log = { warn: jest.fn() }
      const pool = makePool({ lastFechaByAgente: { adminroyal: '2026-01-01' } })
      const now = new Date('2026-09-22T12:00:00.000Z') // way over 60 days
      const { desde, hasta, mode, retentionCapped } = await resolveIncrementalRange(pool, 'ganamos', 'adminroyal', { now, log })

      expect(retentionCapped).toBe(true)
      expect(mode).toBe('ganamos-catchup-capped')
      expect(hasta).toBe('2026-09-22')
      const expectedCap = new Date(now.getTime() - GANAMOS_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10)
      expect(desde).toBe(expectedCap)
      expect(log.warn).toHaveBeenCalledTimes(1)
      expect(log.warn.mock.calls[0][1]).toMatch(/retention window/)
    })

    it('never touches casino_transactions with the Zeus-style MAX(fecha_hora_utc) query', async () => {
      const pool = makePool({ lastFechaByAgente: { adminroyal: '2026-09-20' } })
      await resolveIncrementalRange(pool, 'ganamos', 'adminroyal', { now: new Date('2026-09-21T12:00:00.000Z') })
      expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('MAX(fecha)'), ['adminroyal'])
      expect(pool.query).not.toHaveBeenCalledWith(expect.stringContaining('MAX(fecha_hora_utc)'), expect.anything())
    })
  })

  // ── recovery checkpoint (fase 4 critical-bug fix) ─────────────────────────
  // insertTransactions() commits before recomputePlayers() runs (two separate
  // DB calls inside BaseCasinoConnector.syncAgent()) — if recompute fails, a
  // MAX-based watermark alone advances past the failed range and the next
  // --auto run never revisits it. casino_sync_runs' own range_desde/range_hasta
  // history is the checkpoint that closes this gap.
  describe('recovery from an unresolved failed run (non-ganamos)', () => {
    it('widens desde back to an unresolved failed run\'s range_desde, even though MAX(fecha_hora_utc) has already advanced past it', async () => {
      const pool = makePool({
        lastTxByKey: { 'zeus:betcoin': '2026-09-10T10:00:00.000Z' }, // a later agent-B-style success moved MAX forward
        syncRunsByKey: {
          'zeus:betcoin': [
            runRow({ status: 'failed', desde: '2026-09-01T00:00:00.000Z', hasta: '2026-09-02T00:00:00.000Z', startedAt: '2026-09-02T00:00:00.000Z' }),
          ],
        },
      })
      const { desde, mode } = await resolveIncrementalRange(pool, 'zeus', 'betcoin', { now: new Date('2026-09-11T00:00:00.000Z') })

      expect(mode).toBe('recovery')
      expect(desde).toBe('2026-09-01T00:00:00.000Z')
    })

    it('a later ok run whose range fully contains the failed range resolves it — normal incremental desde is used', async () => {
      const pool = makePool({
        lastTxByKey: { 'zeus:betcoin': '2026-09-10T10:00:00.000Z' },
        syncRunsByKey: {
          'zeus:betcoin': [
            runRow({ status: 'failed', desde: '2026-09-01T00:00:00.000Z', hasta: '2026-09-02T00:00:00.000Z', startedAt: '2026-09-02T00:00:00.000Z' }),
            runRow({ status: 'ok', desde: '2026-08-30T00:00:00.000Z', hasta: '2026-09-05T00:00:00.000Z', startedAt: '2026-09-06T00:00:00.000Z' }),
          ],
        },
      })
      const { desde, mode } = await resolveIncrementalRange(pool, 'zeus', 'betcoin', { now: new Date('2026-09-11T00:00:00.000Z') })

      expect(mode).toBe('incremental')
      expect(desde).toBe('2026-09-10T09:30:00.000Z')
    })

    it('a small later success (e.g. manual partial re-run) does NOT resolve a wider earlier failure', async () => {
      const pool = makePool({
        lastTxByKey: { 'zeus:betcoin': '2026-09-10T10:00:00.000Z' },
        syncRunsByKey: {
          'zeus:betcoin': [
            runRow({ status: 'failed', desde: '2026-09-01T00:00:00.000Z', hasta: '2026-09-05T00:00:00.000Z', startedAt: '2026-09-05T00:00:00.000Z' }),
            // Only re-covers one day of the five-day failure — must not be treated as having closed the gap.
            runRow({ status: 'ok', desde: '2026-09-04T00:00:00.000Z', hasta: '2026-09-04T12:00:00.000Z', startedAt: '2026-09-06T00:00:00.000Z' }),
          ],
        },
      })
      const { desde, mode } = await resolveIncrementalRange(pool, 'zeus', 'betcoin', { now: new Date('2026-09-11T00:00:00.000Z') })

      expect(mode).toBe('recovery')
      expect(desde).toBe('2026-09-01T00:00:00.000Z')
    })

    it('an ok success that happened BEFORE the failure does not resolve it (order matters, not just range)', async () => {
      const pool = makePool({
        lastTxByKey: { 'zeus:betcoin': '2026-09-10T10:00:00.000Z' },
        syncRunsByKey: {
          'zeus:betcoin': [
            runRow({ status: 'ok', desde: '2026-08-01T00:00:00.000Z', hasta: '2026-09-05T00:00:00.000Z', startedAt: '2026-08-31T00:00:00.000Z' }),
            runRow({ status: 'failed', desde: '2026-09-01T00:00:00.000Z', hasta: '2026-09-02T00:00:00.000Z', startedAt: '2026-09-02T00:00:00.000Z' }),
          ],
        },
      })
      const { desde, mode } = await resolveIncrementalRange(pool, 'zeus', 'betcoin', { now: new Date('2026-09-11T00:00:00.000Z') })

      expect(mode).toBe('recovery')
      expect(desde).toBe('2026-09-01T00:00:00.000Z')
    })

    it('recovers a failure that predates any committed transaction at all (bootstrap case)', async () => {
      const pool = makePool({
        syncRunsByKey: {
          'zeus:nuevo-agente': [
            runRow({ status: 'failed', desde: '2023-06-01T00:00:00.000Z', hasta: '2023-06-02T00:00:00.000Z', startedAt: '2023-06-02T00:00:00.000Z' }),
          ],
        },
      })
      const { desde, mode } = await resolveIncrementalRange(pool, 'zeus', 'nuevo-agente', { now: new Date('2026-09-01T12:00:00.000Z') })

      expect(mode).toBe('recovery')
      expect(desde).toBe('2023-06-01T00:00:00.000Z') // widens further back than the 2024-01-01 bootstrap default
    })
  })

  describe('ganamos recovery from an unresolved failed/zero-tx history', () => {
    it('first-ever run failed yesterday with zero transactions recovers yesterday, instead of "today only"', async () => {
      const pool = makePool({
        syncRunsByKey: {
          'ganamos:adminroyal': [
            runRow({ status: 'failed', desde: '2026-09-20', hasta: '2026-09-20', startedAt: '2026-09-20T12:00:00.000Z' }),
          ],
        },
      })
      const now = new Date('2026-09-21T12:00:00.000Z')
      const { desde, hasta, mode } = await resolveIncrementalRange(pool, 'ganamos', 'adminroyal', { now })

      expect(desde).toBe('2026-09-20')
      expect(hasta).toBe('2026-09-21')
      expect(mode).toBe('ganamos-catchup')
    })

    it('last successful run was yesterday with zero transactions — reconsults yesterday rather than skipping to "today only"', async () => {
      const pool = makePool({
        syncRunsByKey: {
          'ganamos:adminroyal': [
            runRow({ status: 'ok', desde: '2026-09-20', hasta: '2026-09-20', startedAt: '2026-09-20T12:00:00.000Z' }),
          ],
        },
      })
      const now = new Date('2026-09-21T12:00:00.000Z')
      const { desde, hasta, mode } = await resolveIncrementalRange(pool, 'ganamos', 'adminroyal', { now })

      expect(desde).toBe('2026-09-20')
      expect(hasta).toBe('2026-09-21')
      expect(mode).toBe('ganamos-catchup')
    })

    it('a small later ok run does not resolve a wider earlier failure for ganamos either', async () => {
      const pool = makePool({
        syncRunsByKey: {
          'ganamos:adminroyal': [
            runRow({ status: 'failed', desde: '2026-09-15', hasta: '2026-09-19', startedAt: '2026-09-19T12:00:00.000Z' }),
            runRow({ status: 'ok', desde: '2026-09-19', hasta: '2026-09-19', startedAt: '2026-09-20T12:00:00.000Z' }),
          ],
        },
      })
      const now = new Date('2026-09-21T12:00:00.000Z')
      const { desde } = await resolveIncrementalRange(pool, 'ganamos', 'adminroyal', { now })

      expect(desde).toBe('2026-09-15') // the 5-day failure is still open, not closed by the 1-day success
    })

    it('recovers the earliest day after several consecutive platform-level (agente=NULL) failures, not just the latest', async () => {
      const pool = makePool({
        syncRunsByKey: {
          // Per-agent query (status IN ('failed','ok')) sees nothing — these are platform-level rows.
        },
      })
      pool.query.mockImplementation(async (sql, params) => {
        if (sql.includes('MAX(fecha)')) return { rows: [{ last_fecha: null }] }
        if (sql.includes('agente IS NULL')) {
          return { rows: ['2026-09-19', '2026-09-20', '2026-09-21'].map((day) => ({ started_at: `${day}T12:00:00Z` })) }
        }
        if (sql.includes('FROM casino_sync_runs')) return { rows: [] }
        throw new Error(`unexpected query: ${sql}`)
      })
      const { desde } = await resolveIncrementalRange(pool, 'ganamos', 'adminroyal', { now: new Date('2026-09-22T12:00:00.000Z') })
      expect(desde).toBe('2026-09-19')
    })

    it('an ok run whose range fully contains the failure resolves it — no eternal replay', async () => {
      const pool = makePool({
        lastFechaByAgente: { adminroyal: '2026-09-19' },
        syncRunsByKey: {
          'ganamos:adminroyal': [
            runRow({ status: 'failed', desde: '2026-09-15', hasta: '2026-09-16', startedAt: '2026-09-16T12:00:00.000Z' }),
            runRow({ status: 'ok', desde: '2026-09-15', hasta: '2026-09-19', startedAt: '2026-09-19T12:00:00.000Z' }),
          ],
        },
      })
      const now = new Date('2026-09-21T12:00:00.000Z')
      const { desde, mode } = await resolveIncrementalRange(pool, 'ganamos', 'adminroyal', { now })

      expect(desde).toBe('2026-09-19') // anchored on the last ok run's range_hasta, not re-walking the resolved failure
      expect(mode).toBe('ganamos-catchup')
    })
  })
})
