'use strict'

jest.mock('../scripts/lib/casino-sync-orchestrator', () => ({
  runOrchestrator: jest.fn(),
  recordPlatformFailure: jest.fn(async () => 'sanitized'),
}))

const { runOrchestrator } = require('../scripts/lib/casino-sync-orchestrator')
const { runAllPlatformSyncs } = require('../scripts/pipeline-diario')

const silentLog = { info: () => {}, warn: () => {}, error: () => {} }

function makePool(lastTimestampByPlatform = {}) {
  return {
    query: jest.fn(async (sql, params) => {
      const [platform] = params
      return { rows: [{ last: lastTimestampByPlatform[platform] ?? null }] }
    }),
  }
}

describe('runAllPlatformSyncs (fase 4 — 4 plataformas desde config)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('runs all 4 platforms and returns a structured per-platform summary (status/txInserted/lastTimestamp)', async () => {
    runOrchestrator.mockImplementation(async ({ platform }) => ({
      platform,
      locked: true,
      ok: true,
      results: [{ agente: 'agent1', status: 'ok', txInserted: 3, desde: '2026-09-01', hasta: '2026-09-02' }],
    }))

    const pool = makePool({ zeus: '2026-09-02T10:00:00.000Z' })
    const summaries = await runAllPlatformSyncs({ pool, log: silentLog })

    expect(summaries.map((s) => s.platform)).toEqual(['zeus', 'bet30', 'ganamos', 'argenbet'])
    expect(summaries.every((s) => s.status === 'ok')).toBe(true)
    expect(summaries[0].txInserted).toBe(3)
    // lastTimestamp comes from a real MAX(fecha_hora_utc) query, not the
    // requested `hasta` boundary — distinct value proves it's not just echoed.
    expect(summaries[0].lastTimestamp).toBe('2026-09-02T10:00:00.000Z')
  })

  it('lastTimestamp reflects what was actually persisted, not the requested window end — a zero-data window reports the true last transaction', async () => {
    runOrchestrator.mockImplementation(async ({ platform }) => ({
      platform, locked: true, ok: true,
      results: [{ agente: 'agent1', status: 'ok', txInserted: 0, desde: '2026-09-01', hasta: '2026-09-21T12:00:00.000Z' }],
    }))
    const pool = makePool({ zeus: '2026-08-15T00:00:00.000Z' }) // last real transaction is way before the requested window end
    const summaries = await runAllPlatformSyncs({ pool, log: silentLog })
    expect(summaries[0].lastTimestamp).toBe('2026-08-15T00:00:00.000Z')
    expect(summaries[0].lastTimestamp).not.toBe('2026-09-21T12:00:00.000Z')
  })

  it('one platform failing does not stop the others, and its summary carries the error', async () => {
    runOrchestrator.mockImplementation(async ({ platform }) => {
      if (platform === 'ganamos') throw new Error('ganamos down')
      return { platform, locked: true, ok: true, results: [] }
    })

    const summaries = await runAllPlatformSyncs({ pool: makePool(), log: silentLog })

    expect(summaries.find((s) => s.platform === 'ganamos').status).toBe('error')
    expect(summaries.find((s) => s.platform === 'ganamos').error).toMatch(/ganamos down/)
    expect(summaries.filter((s) => s.platform !== 'ganamos').every((s) => s.status === 'ok')).toBe(true)
  })

  it('a platform with a per-agent failure is reported as "error" with the failing agent named, not silently "ok"', async () => {
    runOrchestrator.mockImplementation(async ({ platform }) => ({
      platform,
      locked: true,
      ok: platform !== 'argenbet',
      results: platform === 'argenbet'
        ? [{ agente: 'adminroyal', status: 'error', error: 'HTTP 401', desde: '2026-09-01', hasta: '2026-09-02' }]
        : [],
    }))

    const summaries = await runAllPlatformSyncs({ pool: makePool(), log: silentLog })
    const argenbet = summaries.find((s) => s.platform === 'argenbet')
    expect(argenbet.status).toBe('error')
    expect(argenbet.error).toMatch(/adminroyal/)
    expect(argenbet.error).toMatch(/HTTP 401/)
  })

  it('a skipped platform (concurrent lock held) is reported as "skip", not "ok" or "error"', async () => {
    runOrchestrator.mockImplementation(async ({ platform }) => ({
      platform, locked: false, skipped: true, ok: true, results: [],
    }))

    const summaries = await runAllPlatformSyncs({ pool: {}, log: silentLog })
    expect(summaries.every((s) => s.status === 'skip')).toBe(true)
  })
})

describe('runPipeline exit semantics', () => {
  it('exits non-zero (ok:false) when segmentación fails, even if all 4 platform syncs succeeded', async () => {
    jest.resetModules()
    jest.doMock('../scripts/lib/casino-sync-orchestrator', () => ({
      runOrchestrator: jest.fn(async ({ platform }) => ({ platform, locked: true, ok: true, results: [] })),
      recordPlatformFailure: jest.fn(),
    }))
    jest.doMock('child_process', () => ({
      execFileSync: jest.fn(() => { throw new Error('segmentar-casino-players.js failed') }),
    }))
    // No CRON_APP_URL/CRON_SECRET → recompute step is skipped, not failed.
    delete process.env.CRON_APP_URL
    delete process.env.CRON_SECRET

    const { runPipeline } = require('../scripts/pipeline-diario')
    const result = await runPipeline({ pool: makePool(), log: silentLog })

    expect(result.ok).toBe(false)
    expect(result.segmentacionError).toMatch(/segmentar-casino-players/)
    expect(result.platformSummaries.every((s) => s.status === 'ok')).toBe(true)
    jest.dontMock('../scripts/lib/casino-sync-orchestrator')
    jest.dontMock('child_process')
  })

  it('exits non-zero when the injected recompute-prioridades step fails, even with 4 platforms + segmentación OK', async () => {
    jest.resetModules()
    jest.doMock('../scripts/lib/casino-sync-orchestrator', () => ({
      runOrchestrator: jest.fn(async ({ platform }) => ({ platform, locked: true, ok: true, results: [] })),
      recordPlatformFailure: jest.fn(),
    }))

    const { runPipeline } = require('../scripts/pipeline-diario')
    const result = await runPipeline({
      pool: makePool(),
      log: silentLog,
      runSegmentacion: jest.fn().mockResolvedValue(undefined),
      runRecomputePrioridades: jest.fn().mockRejectedValue(new Error('recompute HTTP 500')),
    })

    expect(result.ok).toBe(false)
    expect(result.prioridadesError).toMatch(/recompute HTTP 500/)
    expect(result.segmentacionError).toBeNull()
    jest.dontMock('../scripts/lib/casino-sync-orchestrator')
  })

  it('a getConfigAgents() failure is persisted via recordPlatformFailure, not just left in the in-memory summary', async () => {
    jest.resetModules()
    const recordPlatformFailure = jest.fn(async () => 'sanitized config error')
    jest.doMock('../scripts/lib/casino-sync-orchestrator', () => ({
      runOrchestrator: jest.fn(async ({ platform }) => ({ platform, locked: true, ok: true, results: [] })),
      recordPlatformFailure,
    }))
    jest.doMock('../src/casino-connectors/index', () => ({
      getConfigAgents: jest.fn((platform) => {
        if (platform === 'zeus') throw new Error('platforms.config.json malformed for zeus')
        return ['a']
      }),
    }))

    const { runAllPlatformSyncs } = require('../scripts/pipeline-diario')
    const summaries = await runAllPlatformSyncs({ pool: makePool(), log: silentLog })

    expect(recordPlatformFailure).toHaveBeenCalledWith(expect.anything(), 'zeus', expect.any(Error), undefined)
    expect(summaries.find((s) => s.platform === 'zeus')).toMatchObject({ status: 'error', error: 'sanitized config error' })
    jest.dontMock('../scripts/lib/casino-sync-orchestrator')
    jest.dontMock('../src/casino-connectors/index')
  })
})
