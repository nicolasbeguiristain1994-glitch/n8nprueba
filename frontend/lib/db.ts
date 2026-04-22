import { Pool, PoolClient } from 'pg'

// ── SSL config ───────────────────────────────────────────────────────────────
const sslConfig = (() => {
  if (process.env.DB_SSL === 'false') return false
  const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true'
  return { rejectUnauthorized }
})()

// ── Timeouts ─────────────────────────────────────────────────────────────────
const QUERY_TIMEOUT_MS     = Number(process.env.DB_QUERY_TIMEOUT_MS     || 10000)
const STATEMENT_TIMEOUT_MS = Number(process.env.DB_STATEMENT_TIMEOUT_MS || 10000)
const MAX_LIFETIME_S       = Number(process.env.DB_MAX_LIFETIME_SECONDS  || 300)

export const pool = new Pool({
  host:                    process.env.DB_HOST,
  port:                    Number(process.env.DB_PORT               || 5432),
  database:                process.env.DB_NAME,
  user:                    process.env.DB_USER,
  password:                process.env.DB_PASSWORD,
  ssl:                     sslConfig,
  max:                     Number(process.env.DB_POOL_MAX            || 3),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000),
  idleTimeoutMillis:       Number(process.env.DB_IDLE_TIMEOUT_MS       || 30000),
  maxLifetimeSeconds:      MAX_LIFETIME_S,
  // JS-level timeout — fires even if PgBouncer holds the query before Postgres sees it
  query_timeout:           QUERY_TIMEOUT_MS,
  // Apply statement_timeout on every new connection so queries never hang inside Postgres
  options:                 `--statement_timeout=${STATEMENT_TIMEOUT_MS}`,
})

pool.on('error', (err) => {
  console.error('[db] pool client error:', err.message)
})

pool.on('connect', () => {
  console.log('[db] new client connected — pool total:', pool.totalCount, 'idle:', pool.idleCount)
})

// ── Acquire a raw client (caller must call client.release()) ─────────────────
export async function getDbClient(): Promise<PoolClient> {
  console.log('[db] acquiring client — pool total:', pool.totalCount, 'idle:', pool.idleCount, 'waiting:', pool.waitingCount)
  const client = await pool.connect()
  console.log('[db] client acquired   — pool total:', pool.totalCount, 'idle:', pool.idleCount, 'waiting:', pool.waitingCount)
  return client
}

// ── Simple one-shot query (auto-releases connection) ─────────────────────────
export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const start = Date.now()
  const { rows } = await pool.query(sql, params)
  console.log('[db] query done in', Date.now() - start, 'ms — pool total:', pool.totalCount, 'idle:', pool.idleCount)
  return rows as T[]
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
