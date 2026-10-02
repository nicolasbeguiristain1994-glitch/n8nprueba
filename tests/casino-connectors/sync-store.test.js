'use strict'

const { SyncRunStore, PLATFORM_LOCK_NAMESPACE } = require('../../src/casino-connectors/sync/SyncRunStore')

const META = {
  runId: '11111111-2222-3333-4444-555555555555', platform: 'zeus', mode: 'range', triggeredBy: 'api',
  requestedDesde: '2026-09-01', requestedHasta: '2026-09-13', requestedAgents: ['betcoin'],
}

function makePool(rows = []) {
  const client = { query: jest.fn().mockResolvedValue({ rows: [{ ok: true }] }), release: jest.fn() }
  return {
    client,
    pool: {
      query:   jest.fn().mockResolvedValue({ rows, rowCount: rows.length }),
      connect: jest.fn().mockResolvedValue(client),
    },
  }
}

const flat = sql => sql.replace(/\s+/g, ' ')

describe('SyncRunStore', () => {
  it('always identifies the runner (instance_id is never NULL for a runner)', () => {
    const { pool } = makePool()
    expect(new SyncRunStore(pool).instanceId).toMatch(/.+:\d+/)
  })

  describe('startRun()', () => {
    it('only adopts an API pre-registration: running, instance_id NULL and identical parameters', async () => {
      const { pool } = makePool([{ run_id: META.runId }])
      const store = new SyncRunStore(pool, { instanceId: 'host:1' })
      expect(await store.startRun(META)).toBe(true)

      const [sql, params] = pool.query.mock.calls[0]
      const s = flat(sql)
      expect(s).toMatch(/ON CONFLICT \(run_id\) DO UPDATE/)
      expect(s).toMatch(/casino_sync_runs\.status = 'running'/)
      expect(s).toMatch(/casino_sync_runs\.instance_id IS NULL/)
      expect(s).toMatch(/casino_sync_runs\.triggered_by = EXCLUDED\.triggered_by/)
      expect(s).toMatch(/casino_sync_runs\.platform = EXCLUDED\.platform/)
      expect(s).toMatch(/casino_sync_runs\.mode = EXCLUDED\.mode/)
      expect(s).toMatch(/requested_desde IS NOT DISTINCT FROM EXCLUDED\.requested_desde/)
      expect(s).toMatch(/requested_hasta IS NOT DISTINCT FROM EXCLUDED\.requested_hasta/)
      expect(s).toMatch(/requested_agents IS NOT DISTINCT FROM EXCLUDED\.requested_agents/)
      expect(s).toMatch(/RETURNING run_id/)
      expect(params[7]).toBe('host:1')
    })

    it('returns false (run_id reused) when the existing row is not adoptable', async () => {
      const { pool } = makePool([])
      expect(await new SyncRunStore(pool, { instanceId: 'host:1' }).startRun(META)).toBe(false)
    })
  })

  describe('recordSkippedRun()', () => {
    it('closes as skipped only an adoptable API pre-registration', async () => {
      const { pool } = makePool([{ run_id: META.runId }])
      const store = new SyncRunStore(pool, { instanceId: 'host:1' })
      expect(await store.recordSkippedRun({ ...META, errorCode: 'LOCK_BUSY', errorMessage: 'x' })).toBe(true)
      const s = flat(pool.query.mock.calls[0][0])
      expect(s).toMatch(/casino_sync_runs\.instance_id IS NULL/)
      expect(s).toMatch(/requested_agents IS NOT DISTINCT FROM EXCLUDED\.requested_agents/)
      expect(s).toMatch(/RETURNING run_id/)
    })

    it('returns false without modifying anything when the run_id belongs to another run', async () => {
      const { pool } = makePool([])
      const store = new SyncRunStore(pool, { instanceId: 'host:1' })
      expect(await store.recordSkippedRun({ ...META, errorCode: 'LOCK_BUSY', errorMessage: 'x' })).toBe(false)
    })
  })

  describe('acquirePlatformLock()', () => {
    it('uses a session advisory lock on a dedicated client and destroys it on release', async () => {
      const { pool, client } = makePool()
      const lock = await new SyncRunStore(pool).acquirePlatformLock('zeus')
      expect(lock.acquired).toBe(true)
      expect(client.query.mock.calls[0]).toEqual([
        'SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok', [PLATFORM_LOCK_NAMESPACE, 'casino_sync:zeus'],
      ])
      await lock.release()
      await lock.release()   // idempotente
      expect(client.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1, hashtext($2))', [PLATFORM_LOCK_NAMESPACE, 'casino_sync:zeus'])
      expect(client.release).toHaveBeenCalledTimes(1)
      expect(client.release).toHaveBeenCalledWith(true)
    })

    it('returns the client immediately when the lock is busy', async () => {
      const { pool, client } = makePool()
      client.query.mockResolvedValueOnce({ rows: [{ ok: false }] })
      const lock = await new SyncRunStore(pool).acquirePlatformLock('zeus')
      expect(lock.acquired).toBe(false)
      expect(client.release).toHaveBeenCalledWith()
    })

    it('destroys the client even if the unlock query fails', async () => {
      const { pool, client } = makePool()
      const lock = await new SyncRunStore(pool).acquirePlatformLock('zeus')
      client.query.mockRejectedValueOnce(new Error('connection lost'))
      await expect(lock.release()).rejects.toThrow('connection lost')
      expect(client.release).toHaveBeenCalledWith(true)
    })
  })

  it('finishRun marks a requested segmentation as skipped when the run did not succeed', async () => {
    const { pool } = makePool([{}])
    pool.query.mockResolvedValue({ rows: [], rowCount: 1 })
    await new SyncRunStore(pool).finishRun('r', { status: 'partial' })
    const s = flat(pool.query.mock.calls[0][0])
    expect(s).toMatch(/WHEN \$2 <> 'success' AND segmentation_status = 'pending' THEN 'skipped'/)
    expect(s).toMatch(/WHERE run_id = \$1 AND status = 'running'/)
  })

  it('setSegmentationStatus only advances a successful run and never overwrites a final state', async () => {
    const { pool } = makePool([])
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 })
    const store = new SyncRunStore(pool)
    expect(await store.setSegmentationStatus('r', 'running')).toBe(false)
    const [sql, params] = pool.query.mock.calls[0]
    expect(flat(sql)).toMatch(/AND status = 'success' AND segmentation_status = ANY\(\$3::text\[\]\)/)
    expect(params[2]).toEqual(['pending', 'not_requested'])

    await store.setSegmentationStatus('r', 'success')
    expect(pool.query.mock.calls[1][1][2]).toEqual(['running'])
  })

  it('finishRun refuses to close a run that is no longer running', async () => {
    const { pool } = makePool([])
    await expect(new SyncRunStore(pool).finishRun('r', { status: 'success' }))
      .rejects.toMatchObject({ code: 'RUN_STATE_LOST' })
  })

  it('recordRange persists invalid and excluded counters', async () => {
    const { pool } = makePool([])
    await new SyncRunStore(pool).recordRange(pool, {
      runId: 'r', platform: 'zeus', agente: 'a', desde: '2026-09-01', hasta: '2026-09-02',
      status: 'success', txInvalid: 3, txExcluded: 2,
    })
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toMatch(/tx_invalid, tx_excluded/)
    expect(params).toEqual(expect.arrayContaining([3, 2]))
    expect(params).toHaveLength(21)
  })
})
