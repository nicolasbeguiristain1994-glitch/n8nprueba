'use strict'

const { runSync, EXIT } = require('../../src/casino-connectors/sync/runner')

// "Ahora" = 2026-09-13 12:00 ART → último día cerrado: 2026-09-12
const NOW      = new Date('2026-09-13T15:00:00.000Z')
const RUN_ID   = '11111111-2222-3333-4444-555555555555'

function makeLog() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}

function makeStore({
  lockAcquired = true, cursors = {}, legacy = {}, startAdopts = true,
  failStart = false, failFinish = false, failRecordFailure = false, lockThrows = false,
  skipRecorded = true,
} = {}) {
  const store = {
    pool:     { name: 'pool' },
    ranges:   [],
    cursors:  new Map(Object.entries(cursors)),
    lockRelease: jest.fn(async () => {}),
  }
  Object.assign(store, {
    acquirePlatformLock: jest.fn(async () => {
      if (lockThrows) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
      return { acquired: lockAcquired, release: store.lockRelease }
    }),
    startRun: jest.fn(async () => {
      if (failStart) throw Object.assign(new Error('relation "casino_sync_runs" does not exist'), { code: '42P01' })
      return startAdopts
    }),
    recordSkippedRun:     jest.fn(async () => skipRecorded),
    closeInterruptedRuns: jest.fn(async () => 0),
    heartbeat:            jest.fn(async () => {}),
    finishRun: jest.fn(async () => {
      if (failFinish) throw Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' })
    }),
    getCursor:  jest.fn(async (platform, agente) => store.cursors.get(`${platform}:${agente}`) ?? null),
    saveCursor: jest.fn(async (db, platform, agente, cursor) => { store.cursors.set(`${platform}:${agente}`, cursor) }),
    countUnclassifiedLegacy: jest.fn(async (db, agente) => legacy[agente] ?? 0),
    recordRange: jest.fn(async (db, r) => {
      if (failRecordFailure && r.status === 'failed') throw new Error('insert failed')
      store.ranges.push({ ...r, db })
    }),
  })
  return store
}

const TXN = { name: 'txn-client' }

function summary(overrides = {}) {
  return {
    txCount: 3, txNormalized: 3, insertedTxCount: 2, updatedTxCount: 0, playerCount: 1,
    txWithoutId: 0, txDuplicateIds: 0, txCollapsedWithoutId: 0, txInvalid: 0,
    coverage: 'complete', fetchStartedAt: NOW, ...overrides,
  }
}

/**
 * behavior[agente] puede ser: Error (siempre falla), función (desde, hasta) → Error|summary|undefined.
 */
function makeConnector(behavior = {}, { authError = null } = {}) {
  return {
    authenticate: jest.fn(async () => { if (authError) throw authError }),
    syncAgent: jest.fn(async (agente, desde, hasta, hooks) => {
      let b = behavior[agente]
      if (typeof b === 'function') b = b(desde, hasta)
      if (b instanceof Error) throw b
      if (hooks.beforeWrite) await hooks.beforeWrite(TXN)
      const s = summary(b ?? {})
      if (hooks.afterWrite) await hooks.afterWrite(TXN, s)
      return s
    }),
  }
}

function deps({ store = makeStore(), connector = makeConnector(), createConnector } = {}) {
  return {
    pool:            { name: 'pool' },
    store,
    log:             makeLog(),
    now:             () => NOW,
    sleep:           async () => {},
    createConnector: createConnector ?? (() => connector),
  }
}

const rangeOpts = (extra = {}) => ({
  platform: 'zeus', mode: 'range', desde: '2026-09-01', hasta: '2026-09-13',
  agentes: ['betcoin', 'royal'], runId: RUN_ID, ...extra,
})

describe('runSync()', () => {
  // Aislar del entorno de quien corre los tests: la pausa operativa se lee de
  // process.env por defecto.
  let savedPause
  beforeEach(() => {
    savedPause = process.env.CASINO_SYNC_PAUSED
    delete process.env.CASINO_SYNC_PAUSED
  })
  afterEach(() => {
    if (savedPause === undefined) delete process.env.CASINO_SYNC_PAUSED
    else process.env.CASINO_SYNC_PAUSED = savedPause
  })

  describe('pausa operativa (CASINO_SYNC_PAUSED)', () => {
    function untouchedDeps(env) {
      const pool = { connect: jest.fn(), query: jest.fn() }
      const connector = makeConnector()
      const store = makeStore()
      return {
        d: {
          pool, store, env,
          log: makeLog(), now: () => NOW, sleep: async () => {},
          createConnector: jest.fn(() => connector),
        },
        pool, store, connector,
      }
    }

    it.each([['1'], ['true'], ['valor-desconocido']])(
      'con %p no toca store, lock, base, conector ni proveedor y devuelve fallo no-cero', async value => {
        const { d, pool, store, connector } = untouchedDeps({ CASINO_SYNC_PAUSED: value })
        const res = await runSync(rangeOpts(), d)

        expect(res).toMatchObject({
          runId:     RUN_ID,
          status:    'failed',
          exitCode:  EXIT.FAILED,
          errorCode: 'CASINO_SYNC_PAUSED',
        })
        // exit ≠ 0 y distinto de "omitida por lock": la CLI termina con error y la
        // cadena sync → segmentación no segmenta.
        expect(res.exitCode).not.toBe(EXIT.SUCCESS)
        expect(res.exitCode).not.toBe(EXIT.SKIPPED)
        expect(res.message).toMatch(/pausada/)
        expect(Object.values(res.counters).every(v => v === 0)).toBe(true)

        expect(store.acquirePlatformLock).not.toHaveBeenCalled()
        expect(store.startRun).not.toHaveBeenCalled()
        expect(store.recordSkippedRun).not.toHaveBeenCalled()
        expect(store.finishRun).not.toHaveBeenCalled()
        expect(store.recordRange).not.toHaveBeenCalled()
        expect(pool.connect).not.toHaveBeenCalled()
        expect(pool.query).not.toHaveBeenCalled()
        expect(d.createConnector).not.toHaveBeenCalled()
        expect(connector.authenticate).not.toHaveBeenCalled()
        expect(connector.syncAgent).not.toHaveBeenCalled()
      })

    it('sin store inyectado tampoco usa el pool (no crea corrida)', async () => {
      const pool = { connect: jest.fn(), query: jest.fn() }
      const res = await runSync(rangeOpts(), {
        pool, log: makeLog(), env: { CASINO_SYNC_PAUSED: '1' }, createConnector: jest.fn(),
      })
      expect(res.errorCode).toBe('CASINO_SYNC_PAUSED')
      expect(pool.connect).not.toHaveBeenCalled()
      expect(pool.query).not.toHaveBeenCalled()
    })

    it('lee process.env cuando no se inyecta env', async () => {
      process.env.CASINO_SYNC_PAUSED = 'TRUE'
      const { d, store } = untouchedDeps(undefined)
      delete d.env
      const res = await runSync(rangeOpts(), d)
      expect(res.errorCode).toBe('CASINO_SYNC_PAUSED')
      expect(store.acquirePlatformLock).not.toHaveBeenCalled()
    })

    it.each([[undefined], [''], ['0'], ['false'], [' FALSE ']])(
      'con %p el comportamiento existente sigue igual', async value => {
        const env = value === undefined ? {} : { CASINO_SYNC_PAUSED: value }
        const d   = { ...deps(), env }
        const res = await runSync(rangeOpts(), d)
        expect(res).toMatchObject({ status: 'success', exitCode: EXIT.SUCCESS })
        expect(d.store.acquirePlatformLock).toHaveBeenCalledTimes(1)
      })
  })

  it('success: every agent OK → status success, exit 0, results recorded atomically', async () => {
    const d   = deps()
    const res = await runSync(rangeOpts(), d)

    expect(res).toMatchObject({ runId: RUN_ID, status: 'success', exitCode: EXIT.SUCCESS })
    expect(d.store.finishRun).toHaveBeenCalledWith(RUN_ID, expect.objectContaining({
      status: 'success',
      counters: expect.objectContaining({ agentsTotal: 2, agentsOk: 2, agentsFailed: 0, rangesOk: 2, txFetched: 6, txInserted: 4 }),
    }))
    // resultado y cursor se escriben con el client de la transacción de datos
    expect(d.store.ranges.every(r => r.status === 'success' && r.db === TXN)).toBe(true)
    expect(d.store.saveCursor).toHaveBeenCalledWith(TXN, 'zeus', 'betcoin',
      { coveredFrom: '2026-09-01', coveredThrough: '2026-09-12' }, RUN_ID)
    expect(d.store.lockRelease).toHaveBeenCalledTimes(1)
  })

  it('one agent fails → partial, exit 1, sanitized failure recorded, other agent still synced', async () => {
    const err = new Error('[zeus] All 4 attempts failed for agent "royal": HTTP 503 at https://x.fun/api?token=abc')
    const d   = deps({ connector: makeConnector({ royal: err }) })
    const res = await runSync(rangeOpts(), d)

    expect(res).toMatchObject({ status: 'partial', exitCode: EXIT.FAILED })
    const failed = d.store.ranges.find(r => r.agente === 'royal')
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'UPSTREAM', db: d.store.pool })
    expect(failed.errorMessage).not.toMatch(/token=abc|x\.fun/)
    expect(d.store.ranges.find(r => r.agente === 'betcoin').status).toBe('success')
    expect(d.store.cursors.has('zeus:royal')).toBe(false)
  })

  it('all agents fail → failed, exit 1', async () => {
    const d   = deps({ connector: makeConnector({ betcoin: new Error('HTTP 500'), royal: new Error('HTTP 500') }) })
    const res = await runSync(rangeOpts(), d)
    expect(res).toMatchObject({ status: 'failed', exitCode: EXIT.FAILED })
    expect(d.store.finishRun.mock.calls[0][1].status).toBe('failed')
  })

  it('auth failure → run failed with AUTH, no secrets persisted, lock released, no agent synced', async () => {
    const connector = makeConnector({}, {
      authError: new Error('zeus auto-login failed: HTTP 401 — {"password":"hunter2"} https://admin.zeus/oauth?client_secret=zzz'),
    })
    const d   = deps({ connector })
    const res = await runSync(rangeOpts(), d)

    expect(res).toMatchObject({ status: 'failed', exitCode: EXIT.FAILED, errorCode: 'AUTH' })
    const persisted = d.store.finishRun.mock.calls[0][1]
    expect(persisted).toMatchObject({ status: 'failed', errorCode: 'AUTH' })
    expect(persisted.errorMessage).not.toMatch(/hunter2|zzz|admin\.zeus/)
    expect(connector.syncAgent).not.toHaveBeenCalled()
    expect(d.store.lockRelease).toHaveBeenCalledTimes(1)
  })

  it('lock busy → skipped, exit 3, nothing executed', async () => {
    const createConnector = jest.fn()
    const d   = deps({ store: makeStore({ lockAcquired: false }), createConnector })
    const res = await runSync(rangeOpts(), d)

    expect(res).toMatchObject({ status: 'skipped', exitCode: EXIT.SKIPPED, errorCode: 'LOCK_BUSY' })
    expect(d.store.recordSkippedRun).toHaveBeenCalledWith(expect.objectContaining({ runId: RUN_ID, errorCode: 'LOCK_BUSY' }))
    expect(d.store.startRun).not.toHaveBeenCalled()
    expect(createConnector).not.toHaveBeenCalled()
  })

  it('duplicate run_id while the original is active → RUN_ID_REUSED, exit 1, original untouched', async () => {
    const createConnector = jest.fn()
    const d   = deps({ store: makeStore({ lockAcquired: false, skipRecorded: false }), createConnector })
    const res = await runSync(rangeOpts(), d)
    expect(res).toMatchObject({ status: 'failed', exitCode: EXIT.FAILED, errorCode: 'RUN_ID_REUSED' })
    expect(d.store.startRun).not.toHaveBeenCalled()
    expect(d.store.finishRun).not.toHaveBeenCalled()
    expect(createConnector).not.toHaveBeenCalled()
  })

  it('DB unavailable when taking the lock → failed, exit 1', async () => {
    const d   = deps({ store: makeStore({ lockThrows: true }) })
    const res = await runSync(rangeOpts(), d)
    expect(res).toMatchObject({ status: 'failed', exitCode: EXIT.FAILED, errorCode: 'DB_UNAVAILABLE' })
  })

  it('no agents → explicit failure NO_AGENTS, exit 1', async () => {
    const d   = deps()
    const res = await runSync(rangeOpts({ platform: 'ganamos', agentes: undefined }), d)
    expect(res).toMatchObject({ status: 'failed', exitCode: EXIT.FAILED, errorCode: 'NO_AGENTS' })
  })

  it('connector not implemented → CONNECTOR_UNAVAILABLE, exit 1', async () => {
    const d = deps({ createConnector: () => { throw new Error('connector is not implemented yet') } })
    const res = await runSync(rangeOpts({ platform: 'argenbet' }), d)
    expect(res).toMatchObject({ status: 'failed', errorCode: 'CONNECTOR_UNAVAILABLE' })
  })

  it('startRun cannot adopt the run_id → RUN_ID_REUSED, exit 1', async () => {
    const d   = deps({ store: makeStore({ startAdopts: false }) })
    const res = await runSync(rangeOpts(), d)
    expect(res).toMatchObject({ status: 'failed', errorCode: 'RUN_ID_REUSED', exitCode: EXIT.FAILED })
    expect(d.store.finishRun).not.toHaveBeenCalled()
    expect(d.store.lockRelease).toHaveBeenCalled()
  })

  it('startRun fails (table missing) → failed, exit 1, lock released', async () => {
    const d   = deps({ store: makeStore({ failStart: true }) })
    const res = await runSync(rangeOpts(), d)
    expect(res).toMatchObject({ status: 'failed', errorCode: 'DB_42P01' })
    expect(d.store.lockRelease).toHaveBeenCalled()
  })

  it('persistence failure at finish → exit 1 (never reported as success)', async () => {
    const d   = deps({ store: makeStore({ failFinish: true }) })
    const res = await runSync(rangeOpts(), d)
    expect(res.exitCode).toBe(EXIT.FAILED)
    expect(res.status).toBe('failed')
  })

  it('failure recording the failed range → run failed with PERSISTENCE_FAILED, exit 1', async () => {
    const d   = deps({ store: makeStore({ failRecordFailure: true }), connector: makeConnector({ royal: new Error('HTTP 500') }) })
    const res = await runSync(rangeOpts(), d)
    expect(res).toMatchObject({ status: 'failed', exitCode: EXIT.FAILED, errorCode: 'PERSISTENCE_FAILED' })
    expect(d.store.finishRun.mock.calls[0][1]).toMatchObject({ status: 'failed', errorCode: 'PERSISTENCE_FAILED' })
  })

  it('waits for ALL agent tasks before releasing the lock, and starts no new chunk after persistence loss', async () => {
    const events = []
    let openGate
    const gate = new Promise(r => { openGate = r })

    const store = makeStore({ cursors: { 'zeus:b': { coveredFrom: '2026-07-01', coveredThrough: '2026-08-01' } } })
    const dbDown = () => Object.assign(new Error('connection terminated unexpectedly'), { code: 'ECONNRESET' })
    store.getCursor.mockImplementation(async (platform, agente, db) => {
      if (agente === 'a' && !db) throw dbDown()
      return store.cursors.get(`${platform}:${agente}`) ?? null
    })
    const recordOk = store.recordRange.getMockImplementation()
    store.recordRange.mockImplementation(async (db, r) => {
      if (r.agente === 'a') throw dbDown()
      return recordOk(db, r)
    })
    store.lockRelease.mockImplementation(async () => { events.push('lock:release') })

    const connector = makeConnector()
    const inner = connector.syncAgent.getMockImplementation()
    connector.syncAgent.mockImplementation(async (agente, desde, hasta, hooks) => {
      events.push(`${agente}:start:${desde}`)
      if (agente === 'b') await gate
      const r = await inner(agente, desde, hasta, hooks)
      events.push(`${agente}:end:${desde}`)
      return r
    })

    const d = deps({ store, connector })
    const running = runSync(
      { platform: 'zeus', mode: 'auto', agentes: ['b', 'a'], concurrency: 2, chunkDays: 10, runId: RUN_ID }, d)

    // Esperar a que 'a' pierda la persistencia mientras 'b' sigue dentro de syncAgent.
    for (let i = 0; i < 200 && !store.recordRange.mock.calls.some(c => c[1].agente === 'a'); i++) {
      await new Promise(r => setImmediate(r))
    }
    expect(store.recordRange.mock.calls.some(c => c[1].agente === 'a')).toBe(true)
    expect(store.lockRelease).not.toHaveBeenCalled()

    openGate()
    const res = await running

    expect(res).toMatchObject({ status: 'failed', exitCode: EXIT.FAILED, errorCode: 'PERSISTENCE_FAILED' })
    // 'b' terminó su tramo en curso y no arrancó ninguno más
    expect(events.filter(e => e.startsWith('b:start'))).toHaveLength(1)
    expect(events.indexOf('lock:release')).toBeGreaterThan(events.indexOf('b:end:2026-08-01'))
    expect(events[events.length - 1]).toBe('lock:release')
    expect(store.finishRun).toHaveBeenCalledTimes(1)
    expect(store.finishRun.mock.calls[0][1].status).toBe('failed')
  })

  describe('secrets never reach the DB nor the logs', () => {
    const SECRETS = ['synthetic phrase with spaces', 'zz-secret-777', 'correct horse battery staple']

    function leaked(d) {
      const blob = JSON.stringify([
        d.store.finishRun.mock.calls, d.store.recordRange.mock.calls,
        d.log.error.mock.calls, d.log.warn.mock.calls, d.log.info.mock.calls,
      ])
      return SECRETS.filter(s => blob.includes(s))
    }

    it.each([
      ['auth error with a JSON body', {
        authError: new Error('zeus auto-login failed: HTTP 401 {"password":"synthetic phrase with spaces"}'),
      }],
      ['upstream error with URL and unlabeled free text', {
        agentError: Object.assign(
          new Error('upstream said correct horse battery staple at https://h.invalid/?t=zz-secret-777'),
          { httpStatus: 503 }),
      }],
      ['DB error whose detail carries values', {
        agentError: Object.assign(
          new Error('duplicate key value violates unique constraint: Key (u)=(correct horse battery staple)'),
          { code: '23505' }),
      }],
      ['plain error with unlabeled secret text', {
        agentError: new Error('zz-secret-777 synthetic phrase with spaces'),
      }],
    ])('%s', async (_label, { authError, agentError }) => {
      const connector = makeConnector(agentError ? { betcoin: agentError } : {}, { authError })
      const d = deps({ connector })
      await runSync(rangeOpts({ agentes: ['betcoin'] }), d)
      expect(leaked(d)).toEqual([])
    })

    it('persists a generic allowlisted message with the stable code', async () => {
      const err = Object.assign(new Error('correct horse battery staple'), { httpStatus: 503 })
      const d   = deps({ connector: makeConnector({ betcoin: err }) })
      await runSync(rangeOpts({ agentes: ['betcoin'] }), d)
      expect(d.store.ranges[0]).toMatchObject({
        errorCode:    'UPSTREAM',
        errorMessage: 'La API de la plataforma no respondió correctamente (reintentos agotados). (HTTP 503)',
      })
    })
  })

  describe('auto mode (cursor per platform and agent)', () => {
    it('starts at the last covered day (overlap 1) and advances to the last closed day', async () => {
      const store = makeStore({ cursors: { 'zeus:betcoin': { coveredFrom: '2026-09-01', coveredThrough: '2026-09-10' } } })
      const connector = makeConnector()
      const d = deps({ store, connector })
      await runSync({ platform: 'zeus', mode: 'auto', agentes: ['betcoin'], runId: RUN_ID }, d)

      expect(connector.syncAgent).toHaveBeenCalledWith('betcoin', '2026-09-10', '2026-09-13', expect.any(Object))
      expect(store.cursors.get('zeus:betcoin')).toEqual({ coveredFrom: '2026-09-01', coveredThrough: '2026-09-12' })
    })

    it('agent without cursor fails with CURSOR_MISSING while the others proceed (no MAX global)', async () => {
      const store = makeStore({ cursors: { 'zeus:betcoin': { coveredFrom: '2026-09-01', coveredThrough: '2026-09-12' } } })
      const connector = makeConnector()
      const d   = deps({ store, connector })
      const res = await runSync({ platform: 'zeus', mode: 'auto', agentes: ['betcoin', 'nuevo'], runId: RUN_ID }, d)

      expect(res.status).toBe('partial')
      expect(connector.syncAgent).toHaveBeenCalledTimes(1)
      expect(store.ranges.find(r => r.agente === 'nuevo')).toMatchObject({ status: 'failed', errorCode: 'CURSOR_MISSING' })
    })

    it('new agent with --bootstrap-desde is independent of the other agents', async () => {
      const store = makeStore({ cursors: { 'zeus:betcoin': { coveredFrom: '2026-09-01', coveredThrough: '2026-09-12' } } })
      const connector = makeConnector()
      const d = deps({ store, connector })
      await runSync({ platform: 'zeus', mode: 'auto', agentes: ['betcoin', 'nuevo'], bootstrapDesde: '2026-08-20', runId: RUN_ID }, d)

      expect(connector.syncAgent).toHaveBeenCalledWith('betcoin', '2026-09-12', '2026-09-13', expect.any(Object))
      expect(connector.syncAgent).toHaveBeenCalledWith('nuevo', '2026-08-20', '2026-09-13', expect.any(Object))
      expect(store.cursors.get('zeus:nuevo')).toEqual({ coveredFrom: '2026-08-20', coveredThrough: '2026-09-12' })
    })

    it('an empty successful range still advances the cursor', async () => {
      const store = makeStore({ cursors: { 'zeus:betcoin': { coveredFrom: '2026-09-01', coveredThrough: '2026-09-10' } } })
      const connector = makeConnector({ betcoin: () => ({ txCount: 0, txNormalized: 0, insertedTxCount: 0, playerCount: 0 }) })
      const d = deps({ store, connector })
      const res = await runSync({ platform: 'zeus', mode: 'auto', agentes: ['betcoin'], runId: RUN_ID }, d)

      expect(res.status).toBe('success')
      expect(store.cursors.get('zeus:betcoin').coveredThrough).toBe('2026-09-12')
    })

    it('a failed range does not advance the cursor', async () => {
      const cur   = { coveredFrom: '2026-09-01', coveredThrough: '2026-09-10' }
      const store = makeStore({ cursors: { 'zeus:betcoin': cur } })
      const d = deps({ store, connector: makeConnector({ betcoin: new Error('HTTP 500') }) })
      await runSync({ platform: 'zeus', mode: 'auto', agentes: ['betcoin'], runId: RUN_ID }, d)
      expect(store.cursors.get('zeus:betcoin')).toEqual(cur)
      expect(store.saveCursor).not.toHaveBeenCalled()
    })
  })

  it('a failed chunk stops the following chunks of that agent (recorded as skipped), cursor stays before the gap', async () => {
    const connector = makeConnector({
      betcoin: desde => (desde === '2026-08-11' ? new Error('HTTP 500') : undefined),
    })
    const d = deps({ connector })
    const res = await runSync(rangeOpts({ desde: '2026-08-01', hasta: '2026-08-30', chunkDays: 10, agentes: ['betcoin'] }), d)

    expect(res.status).toBe('failed')
    expect(connector.syncAgent).toHaveBeenCalledTimes(2)
    expect(d.store.ranges.map(r => [r.desde, r.status, r.errorCode ?? null])).toEqual([
      ['2026-08-01', 'success', null],
      ['2026-08-11', 'failed',  'UPSTREAM'],
      ['2026-08-21', 'skipped', 'PREVIOUS_CHUNK_FAILED'],
    ])
    expect(d.store.cursors.get('zeus:betcoin')).toEqual({ coveredFrom: '2026-08-01', coveredThrough: '2026-08-10' })
  })

  it('a disjoint manual range does not move an existing cursor over the gap', async () => {
    const cur   = { coveredFrom: '2026-08-01', coveredThrough: '2026-08-10' }
    const store = makeStore({ cursors: { 'zeus:betcoin': cur } })
    const d = deps({ store })
    const res = await runSync(rangeOpts({ desde: '2026-08-20', hasta: '2026-08-25', agentes: ['betcoin'] }), d)

    expect(res.status).toBe('success')
    expect(store.cursors.get('zeus:betcoin')).toEqual(cur)
    expect(store.ranges[0]).toMatchObject({ status: 'success', cursorMoved: false })
  })

  it('unclassified legacy rows in the range → LEGACY_UNCLASSIFIED before calling the API', async () => {
    const connector = makeConnector()
    const d   = deps({ store: makeStore({ legacy: { bigwin: 12 } }), connector })
    const res = await runSync(rangeOpts({ agentes: ['bigwin'] }), d)

    expect(res.status).toBe('failed')
    expect(connector.syncAgent).not.toHaveBeenCalled()
    expect(d.store.ranges[0]).toMatchObject({ status: 'failed', errorCode: 'LEGACY_UNCLASSIFIED' })
    expect(d.store.ranges[0].errorMessage).toMatch(/12 filas históricas/)
  })

  it('re-checks legacy rows inside the write transaction (beforeWrite)', async () => {
    const d = deps()
    await runSync(rangeOpts({ agentes: ['betcoin'] }), d)
    const dbs = d.store.countUnclassifiedLegacy.mock.calls.map(c => c[0])
    expect(dbs).toEqual([d.store.pool, TXN])
  })

  it('limited coverage is recorded and alerted, not reported as complete', async () => {
    const connector = makeConnector({ betcoin: () => ({ txWithoutId: 2, coverage: 'limited' }) })
    const d = deps({ connector })
    await runSync(rangeOpts({ agentes: ['betcoin'] }), d)
    expect(d.store.ranges[0]).toMatchObject({ coverage: 'limited', txWithoutId: 2 })
    expect(d.log.warn).toHaveBeenCalledWith(expect.objectContaining({ alert: true }), expect.stringMatching(/Cobertura limitada/))
  })

  it('abort signal → remaining chunks skipped as INTERRUPTED, run not successful', async () => {
    const ac = new AbortController()
    ac.abort()
    const connector = makeConnector()
    const d   = deps({ connector })
    const res = await runSync(rangeOpts({ agentes: ['betcoin'], signal: ac.signal }), d)

    expect(connector.syncAgent).not.toHaveBeenCalled()
    expect(res.status).toBe('failed')
    expect(d.store.ranges[0]).toMatchObject({ status: 'skipped', errorCode: 'INTERRUPTED' })
    expect(d.store.finishRun.mock.calls[0][1].errorCode).toBe('INTERRUPTED')
  })
})
