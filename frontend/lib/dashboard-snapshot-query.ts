import { Pool } from 'pg'
import { pool } from './db'

type Runtime = typeof globalThis & { __dashboardQueryPoolV1?: Pool }
const runtime = globalThis as Runtime

// Preparing six months of ledger (90 days plus the comparison period) can take
// more than the interactive pool's 10 seconds. Keep this work bounded and on
// its own two connections, so permission checks and other screens stay fast.
export async function dashboardSnapshotQuery<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
  if (!runtime.__dashboardQueryPoolV1) {
    const financialPool = new Pool({ ...pool.options, password: pool.options.password, min: 0, max: 2,
      query_timeout: 50_000, options: '--statement_timeout=45000' })
    financialPool.on('error', () => console.warn('[dashboard] Background database connection unavailable'))
    runtime.__dashboardQueryPoolV1 = financialPool
  }
  const { rows } = await runtime.__dashboardQueryPoolV1.query(sql, params)
  return rows as T[]
}
