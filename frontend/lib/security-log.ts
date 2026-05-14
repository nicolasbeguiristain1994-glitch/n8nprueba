/**
 * Structured security event logger.
 *
 * Emits a single JSON line to stdout per event so that log aggregators
 * (Datadog, Loki, CloudWatch Logs Insights, etc.) can filter and alert
 * on individual fields without parsing free-form text.
 *
 * Output format:
 *   {"level":"SECURITY","event":"rate_limit_exceeded","ip":"1.2.3.4",...,"ts":"2026-05-14T...Z"}
 *
 * Usage:
 *   securityLog('access_denied', { ip, userId, resource, action })
 *   securityLog('login_failed',  { ip, email, reason: 'password_mismatch' })
 */

export type SecurityEvent =
  | 'login_failed'
  | 'login_success'
  | 'rate_limit_exceeded'
  | 'access_denied'
  | 'session_invalid'
  | 'validation_failed'
  | 'bootstrap_login'
  | 'user_role_changed'
  | 'user_deactivated'

export type SecurityLogPayload = {
  ip?:       string | null
  userId?:   string | null
  email?:    string | null
  resource?: string
  action?:   string
  reason?:   string
  fields?:   string[]
  [key: string]: unknown
}

export function securityLog(event: SecurityEvent, payload: SecurityLogPayload = {}): void {
  const entry = {
    level: 'SECURITY',
    event,
    ...payload,
    ts: new Date().toISOString(),
  }
  // process.stdout.write is synchronous and avoids console's stack-trace prefix.
  process.stdout.write(JSON.stringify(entry) + '\n')
}

// ── Operational logger ────────────────────────────────────────────────────────
//
// Structured JSON logs for non-security operational events (errors, warnings).
// Same format as securityLog so log aggregators can use a single pipeline.
//
// Usage:
//   appLog('ERROR', 'audit write failed', { error: e.message, table: 'rbac_audit_log' })
//   appLog('WARN',  'redis connect failed', { url: redactedUrl })

export type AppLogLevel = 'ERROR' | 'WARN' | 'INFO'

export function appLog(
  level:   AppLogLevel,
  message: string,
  payload: Record<string, unknown> = {},
): void {
  process.stdout.write(JSON.stringify({ level, message, ...payload, ts: new Date().toISOString() }) + '\n')
}
