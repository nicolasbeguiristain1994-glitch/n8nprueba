#!/usr/bin/env node
'use strict'

/**
 * Casino players sync — CLI entry point.
 *
 * This file is a thin wrapper around scripts/lib/casino-sync-orchestrator.js:
 * it parses argv, opens the real DB pool, resolves the agent list (from
 * src/config/platforms.config.json via getConfigAgents() — the SOLE runtime
 * source, same as scripts/pipeline-diario.js; --agentes overrides it but
 * every name must already be one of that platform's configured agents, it
 * is never a way to sync an unvetted agent), calls runOrchestrator(), and
 * maps its result to a process exit code. All actual sync logic (lock,
 * per-agent incremental window, casino_sync_runs bookkeeping, chunking/
 * concurrency for historical backfills) lives in the orchestrator module so
 * it can be unit-tested without a subprocess and reused in-process by
 * scripts/pipeline-diario.js.
 *
 * Nothing below `if (require.main === module)` runs on require() — no .env
 * reading, no DB connection — so this file is safe to require() from tests
 * or from pipeline-diario.js without side effects.
 *
 * Usage:
 *   node scripts/sync-casino-players-live.js --platform=zeus --auto
 *   node scripts/sync-casino-players-live.js --platform=bet30 --desde=2025-01-01 --hasta=2026-05-14 --chunk-days=30 --concurrency=3
 *   node scripts/sync-casino-players-live.js --platform=zeus --agentes=betcoin,bigwin,ofizeus
 *
 * Required env vars (per platform — see src/config/platforms.config.json):
 *   DATABASE_URL, and the platform's own credentials (ZEUS_API_KEY, etc).
 */

const { Pool } = require('pg')

function parseArgs(argv) {
  return Object.fromEntries(
    argv
      .filter((a) => a.startsWith('--'))
      .map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? 'true'] }),
  )
}

/**
 * Resolves the CLI invocation into a `runOrchestrator()` call. Exported so
 * tests can exercise the argv → options mapping without spawning a process.
 */
async function runCli(argv, { pool, createConnector, clock, log } = {}) {
  const { runOrchestrator }              = require('./lib/casino-sync-orchestrator')
  const { getDefaultPlatform, getConfigAgents } = require('../src/casino-connectors/index')

  const args = parseArgs(argv)

  const platform     = args.platform || getDefaultPlatform()
  const auto          = args.auto === 'true'
  const desde         = args.desde || null
  const hasta          = args.hasta || null
  const chunkDays      = Math.max(1, parseInt(args['chunk-days'] ?? '30', 10) || 30)
  const concurrency    = Math.max(1, parseInt(args.concurrency ?? '1', 10) || 1)
  const agentesArg     = args.agentes
    ? args.agentes.split(',').map((a) => a.trim()).filter(Boolean)
    : null

  const configAgentes = getConfigAgents(platform)

  let agentes
  if (agentesArg !== null) {
    const unknown = agentesArg.filter((a) => !configAgentes.includes(a))
    if (unknown.length) {
      return {
        platform, locked: false, ok: false, results: [],
        error: `--agentes contains name(s) not configured for "${platform}": ${unknown.join(', ')} ` +
               `(allowed: ${configAgentes.join(', ')})`,
      }
    }
    agentes = agentesArg
  } else {
    agentes = configAgentes
  }

  return runOrchestrator({
    platform,
    pool,
    createConnector,
    clock,
    log,
    auto,
    desde: auto ? null : (desde || '2020-01-01'),
    hasta,
    agentes,
    chunkDays,
    concurrency,
  })
}

async function main() {
  if (!process.env.DATABASE_URL) {
    process.stderr.write('{"level":50,"msg":"DATABASE_URL is required","component":"sync"}\n')
    process.exit(1)
  }

  const { createLogger } = require('../src/lib/logger')
  const log = createLogger({ component: 'sync' })

  const pool = new Pool({
    connectionString:            process.env.DATABASE_URL,
    max:                          5, // must be >1 — the platform lock holds one connection for the whole run
    keepAlive:                    true,
    keepAliveInitialDelayMillis:  10_000,
    connectionTimeoutMillis:      30_000,
    idleTimeoutMillis:            600_000,
  })
  pool.on('error', (err) => {
    log.error({ err: err.message, code: err.code }, 'Idle DB connection error — el run continúa')
  })

  let result
  try {
    result = await runCli(process.argv.slice(2), { pool, log })
  } catch (err) {
    log.error({ err: err.message, stack: err.stack }, 'Fatal error')
    await pool.end()
    process.exit(1)
  }

  await pool.end()

  log.info(result, result.ok ? 'Sync run complete' : 'Sync run finished with errors')
  process.exit(result.ok ? 0 : 1)
}

if (require.main === module) {
  main()
}

module.exports = { runCli, parseArgs }
