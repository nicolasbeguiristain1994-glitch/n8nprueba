import { pool } from '@/lib/db'
import { getSessionFromRequest } from '@/lib/auth'

// ── Types ─────────────────────────────────────────────────────────────────────

export type AuditStatus = 'success' | 'failure' | 'denied'

export type AuditEvent = {
  req: Request
  action: string
  resource: string
  resource_id?: string | null
  status?: AuditStatus
  metadata?: Record<string, unknown>
  /**
   * Override user identity when no session cookie is present (e.g. login route).
   * Fields left undefined fall back to the session-derived value.
   */
  userOverride?: {
    userId?: string | null
    email?: string | null
    role?: string | null
  }
}

// ── Sanitizer ─────────────────────────────────────────────────────────────────
// Keys blocked from metadata storage — values would be secrets or hashes.

const BLOCKED_KEYS: ReadonlySet<string> = new Set([
  'password',
  'password_hash',
  'passwordhash',
  'passwordhash',
  'token',
  'secret',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'apisecret',
  'api_secret',
])

function sanitizeValue(v: unknown, depth: number): unknown {
  if (depth <= 0) return '[truncated]'
  if (typeof v === 'string') return v.length > 500 ? v.slice(0, 497) + '...' : v
  if (Array.isArray(v)) return v.map(item => sanitizeValue(item, depth - 1))
  if (v !== null && typeof v === 'object') return sanitizeMetadata(v as Record<string, unknown>, depth - 1)
  return v
}

function sanitizeMetadata(raw: Record<string, unknown>, depth = 5): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (BLOCKED_KEYS.has(k.toLowerCase())) continue
    out[k] = sanitizeValue(v, depth)
  }
  return out
}

// ── IP extraction ─────────────────────────────────────────────────────────────

function getIp(req: Request): string | null {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    req.headers.get('x-real-ip') ||
    null
  )
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Write a structured audit event to rbac_audit_log.
 *
 * NEVER throws — a logging failure must not break the calling request.
 * Call with `void audit(...)` for fire-and-forget (non-blocking response).
 *
 * User identity is resolved in order:
 *   1. event.userOverride (explicit)
 *   2. Session cookie on event.req
 *   3. null
 *
 * The 'bootstrap' user_id is stored as NULL in the FK column because
 * 'bootstrap' is not a real UUID and cannot reference users(id).
 */
export async function audit(event: AuditEvent): Promise<void> {
  try {
    const session = getSessionFromRequest(event.req)

    const rawUserId =
      event.userOverride?.userId !== undefined
        ? event.userOverride.userId
        : (session?.user_id ?? null)

    // 'bootstrap' is not a DB row — store NULL in the FK column
    const userId = rawUserId === 'bootstrap' ? null : rawUserId

    const userEmail =
      event.userOverride?.email !== undefined
        ? event.userOverride.email
        : (session?.email ?? null)

    const userRole =
      event.userOverride?.role !== undefined
        ? event.userOverride.role
        : (session?.role ?? null)

    const meta = event.metadata ? sanitizeMetadata(event.metadata) : {}
    const status = event.status ?? 'success'

    await pool.query(
      `INSERT INTO rbac_audit_log
         (user_id, user_email, user_role, action, resource, resource_id,
          status, ip_address, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId,
        userEmail,
        userRole,
        event.action,
        event.resource,
        event.resource_id ?? null,
        status,
        getIp(event.req),
        event.req.headers.get('user-agent') || null,
        JSON.stringify(meta),
      ]
    )
  } catch (e) {
    // Log but never re-throw — audit failure must not break the product flow
    console.error('[audit] write failed:', e instanceof Error ? e.message : String(e))
  }
}
