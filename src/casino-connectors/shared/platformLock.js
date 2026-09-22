'use strict'

/**
 * Fase 4 — Postgres SESSION advisory lock per platform, to stop two
 * simultaneous sync runs (manual button + cron + another manual click) from
 * racing on the same platform's transactions/players tables.
 *
 * Deliberately a SESSION lock (`pg_try_advisory_lock` / `pg_advisory_unlock`
 * on one held client), not the xact-scoped `pg_advisory_xact_lock` that
 * `BaseCasinoConnector.insertTransactions()` already uses against the Excel
 * importer: that one only needs to cover a single DB transaction; this one
 * needs to cover the WHOLE run — connector construction, authenticate(), the
 * full fetch/normalize/insert/recompute loop across every agent — which
 * spans many separate DB transactions and, for the API connectors, several
 * outbound HTTP calls in between. A single held client keeps the lock alive
 * across all of that without ever holding a SQL transaction open during an
 * HTTP call (the lock and per-agent DB writes are independent connections
 * from the pool — see casino-sync-orchestrator.js).
 *
 * The pool passed in MUST allow at least 2 simultaneous connections: one
 * held here for the lock's whole lifetime, plus at least one more for the
 * connector's own inserts/recomputes (`BaseCasinoConnector.insertTransactions`
 * calls `pool.connect()` itself). A `max: 1` pool would deadlock — this
 * module does not create its own pool, so it's the caller's job to size it
 * correctly (`scripts/lib/casino-sync-orchestrator.js` never sets `max: 1`).
 */

function lockKey(platform) {
  return `casino-sync:${platform}`
}

/**
 * Tries to acquire the lock for `platform`. Never blocks — if another run
 * already holds it, resolves with `{ acquired: false }` immediately (the
 * caller "sale limpio, exit 0" per the plan) and the borrowed client is
 * returned to the pool right away, not held for nothing.
 *
 * @param {import('pg').Pool} pool
 * @param {string} platform
 * @returns {Promise<
 *   { acquired: true,  release: () => Promise<void> } |
 *   { acquired: false }
 * >}
 */
async function acquirePlatformLock(pool, platform) {
  const client = await pool.connect()
  const key    = lockKey(platform)

  let locked
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [key])
    locked = rows[0]?.locked === true
  } catch (err) {
    // Couldn't even ask — don't hand back a client whose state we don't trust.
    client.release(err)
    throw err
  }

  if (!locked) {
    client.release() // clean — never held past the failed attempt
    return { acquired: false }
  }

  let released = false
  const release = async () => {
    if (released) return
    released = true
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key])
      client.release()
    } catch (err) {
      // Unlock failing means this connection's session-lock state is now
      // unknown — returning it to the pool could hand the next borrower a
      // connection that still silently holds our lock (or errors confusingly
      // on next use). Destroy it instead of a clean release; the advisory
      // lock is released automatically anyway when Postgres closes the
      // session, and the pool opens a fresh connection to replace it.
      client.release(err)
    }
  }

  return { acquired: true, release }
}

module.exports = { acquirePlatformLock, lockKey }
