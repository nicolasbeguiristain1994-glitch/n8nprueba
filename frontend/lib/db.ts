import { Pool, PoolClient } from 'pg'

// ── Resolve connection source ─────────────────────────────────────────────────
// Priority: DATABASE_URL > DB_HOST + DB_* individual vars
// All string values are trimmed to prevent Railway/Doppler whitespace issues.

const trim = (v: string | undefined) => v?.trim()

// Inject uselibpqcompat=true if missing — prevents pg-connection-string from
// treating sslmode=require as verify-full (SELF_SIGNED_CERT_IN_CHAIN on Railway).
function normalizeDbUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const u = new URL(raw)
    if (!u.searchParams.has('uselibpqcompat')) {
      u.searchParams.set('uselibpqcompat', 'true')
    }
    return u.toString()
  } catch {
    return raw
  }
}

const DATABASE_URL = normalizeDbUrl(trim(process.env.DATABASE_URL))

const dbHost     = trim(process.env.DB_HOST)
const dbPort     = Number(trim(process.env.DB_PORT)     || '5432')
const dbName     = trim(process.env.DB_NAME)
const dbUser     = trim(process.env.DB_USER)
const dbPassword = trim(process.env.DB_PASSWORD)

// ── SSL config ───────────────────────────────────────────────────────────────
const sslConfig = (() => {
  const dbSsl = trim(process.env.DB_SSL)
  if (dbSsl === 'false') return false
  const rejectUnauthorized = trim(process.env.DB_SSL_REJECT_UNAUTHORIZED) === 'true'
  return { rejectUnauthorized }
})()

// ── Startup log — always visible in Railway logs ──────────────────────────────
if (DATABASE_URL) {
  const masked = DATABASE_URL.replace(/:([^:@]+)@/, ':***@')
  console.log('[db] source=DATABASE_URL host=', masked)
} else {
  console.log('[db] source=DB_HOST host=', dbHost ?? '(undefined)', 'port=', dbPort, 'user=', dbUser ?? '(undefined)', 'db=', dbName ?? '(undefined)')
}

if (!DATABASE_URL && !dbHost) {
  console.error('[db] FATAL: no DB_HOST or DATABASE_URL set — pool will fail to connect')
}

// ── Timeouts ─────────────────────────────────────────────────────────────────
const QUERY_TIMEOUT_MS     = Number(trim(process.env.DB_QUERY_TIMEOUT_MS)     || 10000)
const STATEMENT_TIMEOUT_MS = Number(trim(process.env.DB_STATEMENT_TIMEOUT_MS) || 10000)
const MAX_LIFETIME_S       = Number(trim(process.env.DB_MAX_LIFETIME_SECONDS)  || 300)

// ── Pool ─────────────────────────────────────────────────────────────────────
export const pool = new Pool(
  DATABASE_URL
    ? {
        connectionString:        DATABASE_URL,
        ssl:                     sslConfig,
        max:                     Number(trim(process.env.DB_POOL_MAX) || '3'),
        connectionTimeoutMillis: Number(trim(process.env.DB_CONNECTION_TIMEOUT_MS) || '10000'),
        idleTimeoutMillis:       Number(trim(process.env.DB_IDLE_TIMEOUT_MS)       || '30000'),
        maxLifetimeSeconds:      MAX_LIFETIME_S,
        query_timeout:           QUERY_TIMEOUT_MS,
        options:                 `--statement_timeout=${STATEMENT_TIMEOUT_MS}`,
      }
    : {
        host:                    dbHost,
        port:                    dbPort,
        database:                dbName,
        user:                    dbUser,
        password:                dbPassword,
        ssl:                     sslConfig,
        max:                     Number(trim(process.env.DB_POOL_MAX) || '3'),
        connectionTimeoutMillis: Number(trim(process.env.DB_CONNECTION_TIMEOUT_MS) || '10000'),
        idleTimeoutMillis:       Number(trim(process.env.DB_IDLE_TIMEOUT_MS)       || '30000'),
        maxLifetimeSeconds:      MAX_LIFETIME_S,
        query_timeout:           QUERY_TIMEOUT_MS,
        options:                 `--statement_timeout=${STATEMENT_TIMEOUT_MS}`,
      }
)

pool.on('error', (err) => {
  console.error('[db] pool client error:', err.message)
})

pool.on('connect', () => {
  console.log('[db] new client connected — pool total:', pool.totalCount, 'idle:', pool.idleCount)
})

// ── Acquire a raw client (caller must call client.release()) ─────────────────
export async function getDbClient(): Promise<PoolClient> {
  const client = await pool.connect()
  return client
}

// ── Simple one-shot query (auto-releases connection) ─────────────────────────
export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const start = Date.now()
  const { rows } = await pool.query(sql, params)
  console.log('[db] query done in', Date.now() - start, 'ms')
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
