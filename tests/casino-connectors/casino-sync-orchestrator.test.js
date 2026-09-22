'use strict'

const { runOrchestrator, MISSING_TABLE_HINT } = require('../../scripts/lib/casino-sync-orchestrator')

// ── Fake pool: casino_sync_runs bookkeeping + advisory lock, in memory ────────

function makeFakePool({ lockAvailable = true, hasSyncRunsTable = true } = {}) {
  const runs = []
  const clients = []
  let nextId = 1
  let locked = false

  // A NEW client object per connect() call — mirrors the real pool, where
  // pg_try_advisory_lock/pg_advisory_unlock MUST run on the exact same
  // borrowed connection (connection affinity), and lets tests assert which
  // client a given lock attempt actually used.
  function makeClient() {
    const client = {
      query: jest.fn(async (sql) => {
        if (sql.includes('pg_try_advisory_lock')) {
          if (locked || !lockAvailable) return { rows: [{ locked: false }] }
          locked = true
          client.holdsLock = true
          return { rows: [{ locked: true }] }
        }
        if (sql.includes('pg_advisory_unlock')) {
          locked = false
          client.holdsLock = false
          return { rows: [{}] }
        }
        throw new Error(`fake client: unexpected query: ${sql}`)
      }),
      release: jest.fn(),
      holdsLock: false,
    }
    clients.push(client)
    return client
  }

  const query = jest.fn(async (sql, params = []) => {
    if (sql.includes('MAX(fecha_hora_utc)')) {
      return { rows: [{ last: null }] } // bootstrap by default; override via pool.query mock in specific tests if needed
    }
    if (sql.startsWith('INSERT INTO casino_sync_runs')) {
      if (!hasSyncRunsTable) {
        const err = new Error('relation "casino_sync_runs" does not exist')
        err.code = '42P01'
        throw err
      }
      const [platform, agente, startedAt, desde, hasta] = params
      const row = { id: nextId++, platform, agente, started_at: startedAt, range_desde: desde, range_hasta: hasta, status: 'running' }
      runs.push(row)
      return { rows: [{ id: row.id }] }
    }
    if (sql.startsWith('UPDATE casino_sync_runs') && sql.includes("status = 'running'")) {
      // abandoned-run cleanup on lock re-acquisition
      if (!hasSyncRunsTable) {
        const err = new Error('relation "casino_sync_runs" does not exist')
        err.code = '42P01'
        throw err
      }
      const [platform, now] = params
      let count = 0
      for (const row of runs) {
        if (row.platform === platform && row.status === 'running') {
          Object.assign(row, { status: 'failed', finished_at: now, error: 'abandoned' })
          count++
        }
      }
      return { rowCount: count }
    }
    if (sql.startsWith('UPDATE casino_sync_runs')) {
      const [id, status, finishedAt, txInserted, error] = params
      const row = runs.find((r) => r.id === id)
      Object.assign(row, { status, finished_at: finishedAt, tx_inserted: txInserted, error })
      return { rowCount: 1 }
    }
    if (sql.includes('SELECT finished_at FROM casino_sync_runs')) {
      const [agente] = params
      const match = runs
        .filter((r) => r.platform === 'ganamos' && r.agente === agente && r.status === 'ok')
        .sort((a, b) => (b.finished_at > a.finished_at ? 1 : -1))[0]
      return { rows: match ? [{ finished_at: match.finished_at }] : [] }
    }
    if (sql.includes('FROM casino_sync_runs') && sql.includes('agente IS NULL') && sql.includes("status = 'failed'")) {
      // incrementalWindow's Ganamos-only platform-level-failure lookup —
      // agente=NULL rows (a connector construction/authenticate() failure
      // before any agent-level attempt was ever recorded).
      const [platform] = params
      const matched = runs
        .filter((r) => r.platform === platform && r.agente === null && r.status === 'failed')
        .sort((a, b) => (a.started_at > b.started_at ? 1 : -1))
        .map((r) => ({ started_at: r.started_at }))
      return { rows: matched }
    }
    if (sql.includes('FROM casino_sync_runs') && sql.includes('status IN')) {
      // incrementalWindow's recovery-checkpoint lookup — derived from the
      // same in-memory `runs` bookkeeping the rest of this fake pool
      // maintains, so a test that drives a real failed/ok run through
      // runOrchestrator() sees a real recovery answer on the NEXT call.
      const [platform, agente] = params
      const matched = runs
        .filter((r) => r.platform === platform && r.agente === agente && (r.status === 'ok' || r.status === 'failed') && r.range_desde != null && r.range_hasta != null)
        .sort((a, b) => (a.started_at > b.started_at ? 1 : -1))
        .map((r) => ({ status: r.status, range_desde: r.range_desde, range_hasta: r.range_hasta, started_at: r.started_at }))
      return { rows: matched }
    }
    throw new Error(`fake pool: unexpected query: ${sql}`)
  })

  return { pool: { query, connect: async () => makeClient() }, runs, clients }
}

function fakeConnector(behaviors) {
  return {
    authenticate: jest.fn(async () => {
      if (behaviors.authenticateError) throw behaviors.authenticateError
    }),
    syncAgent: jest.fn(async (agente, desde, hasta) => {
      const behavior = behaviors.agents?.[agente]
      if (behavior?.error) throw behavior.error
      return { txCount: behavior?.txCount ?? 0, playerCount: behavior?.playerCount ?? 0, insertedTxCount: behavior?.insertedTxCount ?? 0 }
    }),
  }
}

const clock = () => new Date('2026-09-21T12:00:00.000Z')

describe('runOrchestrator', () => {
  it('runs every agent, records ok runs, and returns ok:true when all succeed', async () => {
    const { pool, runs } = makeFakePool()
    const connector = fakeConnector({ agents: { betcoin: { insertedTxCount: 5 }, royal: { insertedTxCount: 2 } } })

    const result = await runOrchestrator({
      platform: 'zeus', pool, clock,
      createConnector: () => connector,
      agentes: ['betcoin', 'royal'],
      auto: false, desde: '2026-09-01', hasta: '2026-09-21',
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })

    expect(result.ok).toBe(true)
    expect(result.results).toHaveLength(2)
    expect(result.results.find((r) => r.agente === 'betcoin').txInserted).toBe(5)
    expect(runs.every((r) => r.status === 'ok')).toBe(true)
  })

  it('a platform with 4 agents where one fails still runs the other 3, and the summary reports ok:false with the failure detail', async () => {
    const { pool } = makeFakePool()
    const connector = fakeConnector({
      agents: {
        a: { insertedTxCount: 1 },
        b: { error: new Error('network timeout') },
        c: { insertedTxCount: 3 },
        d: { insertedTxCount: 4 },
      },
    })

    const result = await runOrchestrator({
      platform: 'zeus', pool, clock,
      createConnector: () => connector,
      agentes: ['a', 'b', 'c', 'd'],
      auto: false, desde: '2026-09-01', hasta: '2026-09-21',
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })

    expect(result.ok).toBe(false)
    expect(result.results.filter((r) => r.status === 'ok')).toHaveLength(3)
    const failed = result.results.find((r) => r.agente === 'b')
    expect(failed.status).toBe('error')
    expect(failed.error).toMatch(/network timeout/)
  })

  it('records a failed run (agente=null) and returns ok:false when authenticate() throws — never a silent crash', async () => {
    const { pool, runs } = makeFakePool()
    const connector = fakeConnector({ authenticateError: new Error('bad credentials') })

    const result = await runOrchestrator({
      platform: 'argenbet', pool, clock,
      createConnector: () => connector,
      agentes: ['adminroyal'],
      auto: false, desde: '2026-09-01', hasta: '2026-09-21',
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/bad credentials/)
    expect(runs).toHaveLength(1)
    expect(runs[0].agente).toBeNull()
    expect(runs[0].status).toBe('failed')
  })

  it('running the exact same range 10 times in a row leaves txInserted at 0 from the second run onward (idempotent replay)', async () => {
    const { pool } = makeFakePool()
    // Simulates BaseCasinoConnector's own dedup: only the FIRST call actually inserts anything.
    let firstCall = true
    const connector = {
      authenticate: jest.fn(async () => {}),
      syncAgent: jest.fn(async () => {
        const inserted = firstCall ? 5 : 0
        firstCall = false
        return { txCount: 5, playerCount: 1, insertedTxCount: inserted }
      }),
    }

    const runResults = []
    for (let i = 0; i < 10; i++) {
      const result = await runOrchestrator({
        platform: 'zeus', pool, clock,
        createConnector: () => connector,
        agentes: ['betcoin'],
        auto: false, desde: '2026-09-01', hasta: '2026-09-21',
        log: { info: () => {}, warn: () => {}, error: () => {} },
      })
      runResults.push(result.results[0].txInserted)
    }

    expect(runResults[0]).toBe(5)
    expect(runResults.slice(1)).toEqual(new Array(9).fill(0))
  })

  it('a second concurrent run for the same platform is skipped cleanly (ok:true, skipped:true), never touching the connector', async () => {
    const { pool } = makeFakePool({ lockAvailable: false })
    const createConnector = jest.fn()

    const result = await runOrchestrator({
      platform: 'zeus', pool, clock, createConnector,
      agentes: ['betcoin'], auto: false, desde: '2026-09-01', hasta: '2026-09-21',
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })

    expect(result).toEqual({ platform: 'zeus', locked: false, skipped: true, ok: true, results: [] })
    expect(createConnector).not.toHaveBeenCalled()
  })

  it('releases the lock even when an agent throws, so a subsequent run can acquire it', async () => {
    const { pool } = makeFakePool()
    const connector = fakeConnector({ agents: { a: { error: new Error('boom') } } })
    const log = { info: () => {}, warn: () => {}, error: () => {} }

    await runOrchestrator({ platform: 'zeus', pool, clock, createConnector: () => connector, agentes: ['a'], auto: false, desde: '2026-09-01', hasta: '2026-09-21', log })

    const second = await runOrchestrator({ platform: 'zeus', pool, clock, createConnector: () => connector, agentes: ['a'], auto: false, desde: '2026-09-01', hasta: '2026-09-21', log })
    expect(second.locked).toBe(true) // lock was released after the first run, so this one acquired it
  })

  it('throws a clear, actionable error when casino_sync_runs does not exist (migration 128 not applied) — never a silent no-op', async () => {
    const { pool } = makeFakePool({ hasSyncRunsTable: false })
    const connector = fakeConnector({ agents: { a: { insertedTxCount: 1 } } })

    await expect(runOrchestrator({
      platform: 'zeus', pool, clock, createConnector: () => connector,
      agentes: ['a'], auto: false, desde: '2026-09-01', hasta: '2026-09-21',
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })).rejects.toThrow(MISSING_TABLE_HINT)
  })

  it('auto mode resolves a per-agent incremental window instead of the caller-provided desde/hasta', async () => {
    const { pool } = makeFakePool()
    const connector = fakeConnector({ agents: { betcoin: { insertedTxCount: 1 } } })

    const result = await runOrchestrator({
      platform: 'zeus', pool, clock, createConnector: () => connector,
      agentes: ['betcoin'], auto: true, chunkDays: 10_000, // wide enough that the ~2.5yr bootstrap stays a single chunk
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })

    expect(result.ok).toBe(true)
    // Bootstrap mode (fake pool returns last:null) — desde must be the documented constant, hasta the clock.
    expect(result.results[0].desde).toBe('2024-01-01')
    expect(result.results[0].hasta).toBe(clock().toISOString())
  })

  it('an empty configured agent list is a visible config failure (ok:false), never a silent "nothing to do" success', async () => {
    const { pool, runs } = makeFakePool()
    const result = await runOrchestrator({
      platform: 'zeus', pool, clock, createConnector: () => fakeConnector({}),
      agentes: [], auto: true,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/No agents configured/)
    expect(runs.find((r) => r.agente === null).status).toBe('failed')
  })

  it('throws on invalid chunkDays/concurrency instead of silently clamping to 1', async () => {
    const { pool } = makeFakePool()
    const base = { platform: 'zeus', pool, clock, createConnector: () => fakeConnector({}), agentes: ['a'], auto: false, desde: '2026-09-01', hasta: '2026-09-02' }
    await expect(runOrchestrator({ ...base, chunkDays: 0 })).rejects.toThrow(/chunkDays/)
    await expect(runOrchestrator({ ...base, concurrency: -1 })).rejects.toThrow(/concurrency/)
    await expect(runOrchestrator({ ...base, desde: 'not-a-date' })).rejects.toThrow(/desde/)
  })

  it('a resolveIncrementalRange failure for one agent is recorded and does not abort the rest of the platform', async () => {
    const { pool, runs } = makeFakePool()
    const badAgentQuery = jest.fn(async (sql, params) => {
      if (sql.includes('MAX(fecha_hora_utc)') && params[1] === 'broken') {
        throw new Error('connection reset')
      }
      return pool.query(sql, params)
    })
    const wrappedPool = { ...pool, query: badAgentQuery }
    const connector = fakeConnector({ agents: { broken: { insertedTxCount: 1 }, healthy: { insertedTxCount: 2 } } })

    const result = await runOrchestrator({
      platform: 'zeus', pool: wrappedPool, clock, createConnector: () => connector,
      agentes: ['broken', 'healthy'], auto: true, chunkDays: 10_000, // single chunk — chunking itself is covered separately
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })

    expect(result.ok).toBe(false)
    const broken  = result.results.find((r) => r.agente === 'broken')
    const healthy = result.results.find((r) => r.agente === 'healthy')
    expect(broken.status).toBe('error')
    expect(broken.error).toMatch(/connection reset/)
    expect(healthy.status).toBe('ok') // never aborted by broken's failure
    expect(healthy.txInserted).toBe(2)
  })

  it('marks a leftover "running" row from a crashed prior process as failed on lock re-acquisition', async () => {
    const { pool, runs } = makeFakePool()
    // Simulate a crash: a running row with no finished_at, left over from "before".
    runs.push({ id: 999, platform: 'zeus', agente: 'ghost', started_at: new Date('2026-09-01'), status: 'running' })

    const connector = fakeConnector({ agents: { a: { insertedTxCount: 1 } } })
    await runOrchestrator({
      platform: 'zeus', pool, clock, createConnector: () => connector,
      agentes: ['a'], auto: false, desde: '2026-09-01', hasta: '2026-09-02',
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })

    const ghost = runs.find((r) => r.id === 999)
    expect(ghost.status).toBe('failed')
    expect(ghost.error).toMatch(/abandoned/)
  })

  it('wires GanamosConnector.checkStaleSync() to the last successful casino_sync_runs.finished_at for that agent', async () => {
    const { pool, runs } = makeFakePool()
    runs.push({ id: 1, platform: 'ganamos', agente: 'adminroyal', status: 'ok', finished_at: new Date('2026-09-01T00:00:00Z') })

    const checkStaleSync = jest.fn()
    const connector = { authenticate: jest.fn(), syncAgent: jest.fn(async () => ({ insertedTxCount: 0 })), checkStaleSync }

    await runOrchestrator({
      platform: 'ganamos', pool, clock, createConnector: () => connector,
      agentes: ['adminroyal'], auto: true,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })

    expect(checkStaleSync).toHaveBeenCalledWith('adminroyal', new Date('2026-09-01T00:00:00Z'), clock())
  })

  it('a second, genuinely concurrent run for the same platform is skipped using a DIFFERENT client, never touching the connector, while the first still holds the lock', async () => {
    const { acquirePlatformLock } = require('../../src/casino-connectors/shared/platformLock')
    const { pool, clients } = makeFakePool()

    // Hold the lock directly, exactly like a first run that is still in progress.
    const heldLock = await acquirePlatformLock(pool, 'zeus')
    expect(heldLock.acquired).toBe(true)
    const firstClient = clients[0]
    expect(firstClient.holdsLock).toBe(true)

    const secondCreateConnector = jest.fn()
    const second = await runOrchestrator({
      platform: 'zeus', pool, clock, createConnector: secondCreateConnector,
      agentes: ['a'], auto: false, desde: '2026-09-01', hasta: '2026-09-02',
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })

    expect(second).toEqual({ platform: 'zeus', locked: false, skipped: true, ok: true, results: [] })
    expect(secondCreateConnector).not.toHaveBeenCalled()
    // The second attempt used a DIFFERENT client than the one holding the lock —
    // connection affinity means only the ORIGINAL holder's client can unlock it.
    const secondClient = clients[1]
    expect(secondClient).toBeDefined()
    expect(secondClient).not.toBe(firstClient)
    expect(secondClient.release).toHaveBeenCalledWith() // returned to the pool immediately, not held
    expect(firstClient.holdsLock).toBe(true) // still held by the first run — untouched by the second's failed attempt

    // A third attempt, after the first releases, DOES acquire it (on yet another client).
    await heldLock.release()
    const third = await runOrchestrator({
      platform: 'zeus', pool, clock, createConnector: () => fakeConnector({ agents: { a: { insertedTxCount: 1 } } }),
      agentes: ['a'], auto: false, desde: '2026-09-01', hasta: '2026-09-02',
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })
    expect(third.locked).toBe(true)
  })

  // ── fase 4 critical-bug fix: recovery/idempotency under partial failure ────

  it.each([false, true])('records and reports committed inserts after a recompute failure (auto=%s)', async (auto) => {
    const { pool, runs } = makeFakePool()
    const err = Object.assign(new Error('recompute exploded'), { insertedTxCount: 7 })
    const connector = fakeConnector({ agents: { betcoin: { error: err } } })

    const result = await runOrchestrator({
      platform: 'zeus', pool, clock, createConnector: () => connector,
      agentes: ['betcoin'], auto, desde: '2026-09-01', hasta: '2026-09-02',
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })

    expect(result.results[0].status).toBe('error')
    const row = runs.find((r) => r.agente === 'betcoin')
    expect(row.status).toBe('failed')
    expect(row.tx_inserted).toBe(7) // not null/0 — the transactions genuinely landed before recompute failed
    expect(result.results[0].txInserted).toBe(7)
  })

  it('stops running LATER chunks for an agent once one chunk fails, but other agents keep going', async () => {
    const { pool, runs } = makeFakePool()
    let bCallCount = 0
    const connector = {
      authenticate: jest.fn(async () => {}),
      syncAgent: jest.fn(async (agente) => {
        if (agente === 'b') {
          bCallCount++
          throw new Error('b failed on its first chunk')
        }
        return { txCount: 1, playerCount: 1, insertedTxCount: 1 }
      }),
    }

    const result = await runOrchestrator({
      platform: 'zeus', pool, clock, createConnector: () => connector,
      agentes: ['a', 'b'], auto: false, desde: '2026-01-01', hasta: '2026-03-31', chunkDays: 30, // 3 chunks
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })

    expect(bCallCount).toBe(1) // never retried a later chunk for b within this same call
    const bResult = result.results.find((r) => r.agente === 'b')
    const aResult = result.results.find((r) => r.agente === 'a')
    expect(bResult.status).toBe('error')
    expect(aResult.status).toBe('ok')
    expect(aResult.txInserted).toBe(3) // a ran all 3 chunks successfully
    expect(runs.filter((r) => r.agente === 'b')).toHaveLength(1) // only the one failed attempt was ever recorded
    expect(runs.filter((r) => r.agente === 'a')).toHaveLength(3)
  })

  it('a later --auto run recovers an earlier failed chunk\'s range via casino_sync_runs, instead of skipping past it', async () => {
    const { pool, runs } = makeFakePool()

    // First call: an explicit historical chunk fails for this agent.
    const failingConnector = {
      authenticate: jest.fn(async () => {}),
      syncAgent: jest.fn(async () => { throw new Error('platform outage') }),
    }
    await runOrchestrator({
      platform: 'zeus', pool, clock, createConnector: () => failingConnector,
      agentes: ['betcoin'], auto: false, desde: '2026-09-01', hasta: '2026-09-01',
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })
    const betcoinRun = runs.find((r) => r.agente === 'betcoin')
    expect(betcoinRun.status).toBe('failed')
    expect(betcoinRun.range_desde).toBe('2026-09-01')

    // Second call: a healthy --auto run. MAX(fecha_hora_utc) is still null in
    // this fake pool (no transactions were ever committed), so this bootstraps
    // from the documented platform default — which, being earlier than the
    // failed 2026-09-01 chunk, already re-covers it (bootstrap is the widest
    // possible range, so recovery has nothing further to widen here).
    const recoveredConnector = fakeConnector({ agents: { betcoin: { insertedTxCount: 3 } } })
    const secondClock = () => new Date('2026-09-05T00:00:00.000Z')
    const result = await runOrchestrator({
      platform: 'zeus', pool, clock: secondClock, createConnector: () => recoveredConnector,
      agentes: ['betcoin'], auto: true, chunkDays: 10_000, // single chunk — chunking itself is covered separately
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })

    expect(result.ok).toBe(true)
    expect(result.results[0].desde).toBe('2024-01-01') // AUTO_BOOTSTRAP_DESDE.zeus — already covers the failed 2026-09-01 chunk
    expect(result.results[0].hasta).toBe(secondClock().toISOString())
  })

  it('a later --auto run recovers a failed INCREMENTAL chunk (MAX already advanced past it via a different agent) instead of skipping it', async () => {
    const { pool, runs } = makeFakePool()

    // betcoin already has committed data from 2026-09-05 (simulates a prior
    // successful incremental run) so the next --auto call is in 'incremental'
    // mode, not 'bootstrap' — this is the shape where losing the checkpoint
    // actually bites: MAX(fecha_hora_utc)-30min sits entirely AFTER the gap.
    const queryWithMax = jest.fn(async (sql, params) => {
      if (sql.includes('MAX(fecha_hora_utc)')) {
        return { rows: [{ last: '2026-09-05T10:00:00.000Z' }] }
      }
      return pool.query(sql, params)
    })
    const poolWithMax = { ...pool, query: queryWithMax }

    const failingConnector = {
      authenticate: jest.fn(async () => {}),
      syncAgent: jest.fn(async () => { throw new Error('recompute exploded mid-run') }),
    }
    await runOrchestrator({
      platform: 'zeus', pool: poolWithMax, clock, createConnector: () => failingConnector,
      agentes: ['betcoin'], auto: false, desde: '2026-09-01', hasta: '2026-09-01',
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })

    const recoveredConnector = fakeConnector({ agents: { betcoin: { insertedTxCount: 3 } } })
    const secondClock = () => new Date('2026-09-10T00:00:00.000Z')
    const result = await runOrchestrator({
      platform: 'zeus', pool: poolWithMax, clock: secondClock, createConnector: () => recoveredConnector,
      agentes: ['betcoin'], auto: true,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })

    expect(result.ok).toBe(true)
    // Without the recovery checkpoint this would be '2026-09-05T09:30:00.000Z'
    // (MAX - 30min) — entirely past the failed 2026-09-01 chunk, losing it.
    expect(result.results[0].desde).toBe('2026-09-01')
  })
})
