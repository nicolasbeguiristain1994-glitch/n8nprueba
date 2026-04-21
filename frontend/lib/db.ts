import { Pool, PoolClient } from 'pg'

// ── SSL config ───────────────────────────────────────────────────────────────
// DB_SSL=false          → disable SSL entirely
// DB_SSL_REJECT_UNAUTHORIZED=true → strict certificate validation (default: off)
const sslConfig = (() => {
  if (process.env.DB_SSL === 'false') return false
  // Default: enabled with rejectUnauthorized false for Supabase/Railway compatibility
  // Set DB_SSL_REJECT_UNAUTHORIZED=true for stricter validation
  const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true'
  return { rejectUnauthorized }
})()

const pool = new Pool({
  host:                    process.env.DB_HOST,
  port:                    Number(process.env.DB_PORT               || 5432),
  database:                process.env.DB_NAME,
  user:                    process.env.DB_USER,
  password:                process.env.DB_PASSWORD,
  ssl:                     sslConfig,
  max:                     Number(process.env.DB_POOL_MAX            || 5),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 5000),
  idleTimeoutMillis:       Number(process.env.DB_IDLE_TIMEOUT_MS       || 30000),
})

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const { rows } = await pool.query(sql, params)
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
