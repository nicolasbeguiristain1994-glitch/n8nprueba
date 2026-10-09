// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ configs: [] as Record<string, unknown>[], query: vi.fn(), on: vi.fn() }))
vi.mock('pg', () => ({ Pool: class {
  query = mocks.query; on = mocks.on
  constructor(options: Record<string, unknown>) { mocks.configs.push(options) }
} }))
vi.mock('@/lib/db', () => ({ pool: { options: { connectionString: 'postgresql://synthetic.invalid/db', ssl: { rejectUnauthorized: true }, max: 10, query_timeout: 10_000 } } }))
import { dashboardSnapshotQuery } from '../dashboard-snapshot-query'
afterEach(() => { delete (globalThis as { __dashboardQueryPoolV1?: unknown }).__dashboardQueryPoolV1; vi.resetAllMocks(); mocks.configs.length = 0 })
it('shares a bounded financial pool without changing interactive timeouts or TLS', async () => {
  mocks.query.mockResolvedValue({ rows: [{ total: 7 }] })
  expect(await dashboardSnapshotQuery('SELECT 7 AS total')).toEqual([{ total: 7 }])
  await dashboardSnapshotQuery('SELECT $1 AS total', [8])
  expect(mocks.configs).toHaveLength(1)
  expect(mocks.configs[0]).toMatchObject({ min: 0, max: 2, query_timeout: 50_000, options: '--statement_timeout=45000', ssl: { rejectUnauthorized: true } })
  expect(mocks.query).toHaveBeenLastCalledWith('SELECT $1 AS total', [8])
})
it('propagates errors so failed computations cannot become valid cached zeros', async () => {
  mocks.query.mockRejectedValue(Error('statement timeout'))
  await expect(dashboardSnapshotQuery('SELECT 1')).rejects.toThrow('statement timeout')
})
