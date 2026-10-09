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
  const client = await runtime.__dashboardQueryPoolV1.connect()
  let discard = false
  try {
    // Transaction poolers may ignore connection startup options. Apply the
    // deadline on the same backend as the SELECT so abandoned work stops in PG.
    await client.query('BEGIN READ ONLY')
    await client.query("SET LOCAL statement_timeout = '45s'")
    const { rows } = await client.query(sql, params)
    await client.query('COMMIT')
    return rows as T[]
  } catch (error) {
    // A client-side timeout can leave a query running or a transaction aborted.
    // Closing this connection avoids returning either state to the pool.
    discard = true
    throw error
  } finally {
    client.release(discard)
  }
}
