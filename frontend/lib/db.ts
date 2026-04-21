import { Pool } from 'pg'

const pool = new Pool({
  host:                    process.env.DB_HOST,
  port:                    Number(process.env.DB_PORT               || 5432),
  database:                process.env.DB_NAME,
  user:                    process.env.DB_USER,
  password:                process.env.DB_PASSWORD,
  ssl:                     { rejectUnauthorized: false },
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
