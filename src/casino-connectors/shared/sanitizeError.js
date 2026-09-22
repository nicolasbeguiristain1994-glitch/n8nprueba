'use strict'

/**
 * Best-effort redaction for error messages that get PERSISTED
 * (casino_sync_runs.error) or logged from a layer that didn't already
 * sanitize its own message (connectors do this themselves — see
 * ZeusConnector.authenticate()'s `redact()` — this is the orchestrator-level
 * backstop for constructor/authenticate/unexpected errors that reach
 * scripts/lib/casino-sync-orchestrator.js without having gone through a
 * connector's own redaction).
 *
 * Strips: URL query strings (auth is frequently passed as `?token=...` —
 * see ZeusConnector's OAuth login URL), `Authorization: Bearer <token>`
 * headers, and any standalone token-shaped run of 20+ alnum/./-/_ characters
 * (JWTs, session ids, API keys) that isn't obviously a normal English/Spanish
 * word. Never perfect — a determined secret could still slip through in
 * unusual shapes — but removes the common cases without needing this module
 * to know every provider's exact error format.
 */
function sanitizeErrorMessage(err) {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  let out = raw
    .replace(/(\?[^\s"']*)/g, '?[REDACTED_QUERY]')
    .replace(/(authorization\s*:?\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/\b[A-Za-z0-9._-]{24,}\b/g, (m) => (/^[0-9]+$/.test(m) ? m : '[REDACTED]'))

  return out.slice(0, 2000)
}

module.exports = { sanitizeErrorMessage }
