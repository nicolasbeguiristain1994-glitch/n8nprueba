#!/usr/bin/env node
'use strict'

/**
 * Casino players sync — orchestrator script.
 *
 * Reads agents from the DB (or --agentes override), runs the full sync pipeline
 * for each one via the platform connector, and persists results to:
 *   casino_players      (aggregated per-player stats)
 *   casino_transactions (raw transaction rows)
 *
 * Usage:
 *   node scripts/sync-casino-players-live.js
 *   node scripts/sync-casino-players-live.js --platform=zeus
 *   node scripts/sync-casino-players-live.js --desde=2024-01-01 --hasta=2026-05-12
 *   node scripts/sync-casino-players-live.js --auto
 *   node scripts/sync-casino-players-live.js --agentes=betcoin,royal,ofizeus
 *
 * Required env vars (per platform — see src/config/platforms.config.json):
 *   DATABASE_URL
 *   ZEUS_API_KEY
 *   ZEUS_PLAYER_TOKEN
 *   ZEUS_API_BASE  (optional — overrides config baseUrl)
 */

const { Pool }                               = require('pg')
const { createConnector, getDefaultPlatform } = require('../src/casino-connectors/index')
const { createLogger }                        = require('../src/lib/logger')

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? 'true'] })
)

const PLATFORM       = args.platform || getDefaultPlatform()
const AUTO           = args.auto === 'true'
const DESDE_ARG      = args.desde || '2020-01-01'
const HASTA_ARG      = args.hasta || new Date().toISOString().split('T')[0]
const AGENTES_FILTER = args.agentes
  ? args.agentes.split(',').map(a => a.trim()).filter(Boolean)
  : null  // null = all agents from DB

// ── DB pool ───────────────────────────────────────────────────────────────────

if (!process.env.DATABASE_URL) {
  // Logger not yet available — plain stderr before process.exit
  process.stderr.write('{"level":50,"msg":"DATABASE_URL is required","component":"sync"}\n')
  process.exit(1)
}

const log = createLogger({ component: 'sync', platform: PLATFORM })

const pool = new Pool({
  connectionString:             process.env.DATABASE_URL,
  keepAlive:                    true,
  keepAliveInitialDelayMillis:  10_000,
  connectionTimeoutMillis:      30_000,
  idleTimeoutMillis:            600_000,  // longer than the slowest Zeus API call
})

// ── DB queries (orchestration-level, not platform-specific) ───────────────────

async function resolveDesde(pool) {
  if (!AUTO) return DESDE_ARG
  const { rows } = await pool.query(
    `SELECT (MAX(fecha) + INTERVAL '1 day')::date::text AS desde FROM casino_transactions`
  )
  const desde = rows[0]?.desde ?? '2020-01-01'
  log.info({ desde }, 'Auto mode: resolved start date from DB')
  return desde
}

async function getAgentes(pool) {
  const { rows } = await pool.query(
    `SELECT DISTINCT agente FROM casino_players
     WHERE agente IS NOT NULL
       AND ($1::text[] IS NULL OR agente = ANY($1::text[]))
     ORDER BY agente`,
    [AGENTES_FILTER]
  )
  const fromDb = rows.map(r => r.agente)

  // Bootstrap: if casino_players is empty and --agentes was passed explicitly,
  // use that list directly rather than silently doing nothing.
  if (fromDb.length === 0 && AGENTES_FILTER !== null) {
    log.info('casino_players is empty — using --agentes list as bootstrap')
    return AGENTES_FILTER
  }

  return fromDb
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const connector = createConnector(PLATFORM, pool)

  await connector.authenticate()

  const desde = await resolveDesde(pool)
  const hasta = HASTA_ARG

  if (AUTO && desde > hasta) {
    log.info({ hasta }, 'Already synced — nothing to do')
    await pool.end()
    return
  }

  log.info({ platform: PLATFORM, from: desde, to: hasta }, 'Starting sync run')

  const agentes = await getAgentes(pool)
  if (!agentes.length) {
    log.warn('No agents found — use --agentes=name1,name2 to bootstrap')
    await pool.end()
    return
  }
  log.info({ count: agentes.length, agents: agentes }, 'Agents loaded')

  let totalPlayers = 0

  for (const agente of agentes) {
    try {
      const { txCount, playerCount, insertedTxCount } =
        await connector.syncAgent(agente, desde, hasta)

      totalPlayers += playerCount
      log.info({ agent: agente, txCount, playerCount, insertedTxCount }, 'Agent synced')
    } catch (err) {
      log.error({ agent: agente, err: err.message }, 'Agent sync failed')
    }

    // Brief pause to avoid saturating the platform API
    await new Promise(r => setTimeout(r, 400))
  }

  log.info({ totalPlayers }, 'Sync run complete')
  await pool.end()
}

main().catch(err => {
  log.error({ err: err.message, stack: err.stack }, 'Fatal error')
  pool.end()
  process.exit(1)
})
