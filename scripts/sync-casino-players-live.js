#!/usr/bin/env node
'use strict'

/**
 * Casino players sync — CLI.
 *
 * La lógica vive en src/casino-connectors/sync/runner.js (testeable). Este
 * archivo solo parsea argumentos, arma el pool y fija el código de salida.
 *
 * Por cada agente y tramo de fechas, en UNA transacción:
 *   casino_transactions  ← movimientos del casino, con plataforma (dedup por plataforma+ID)
 *   casino_players       ← recalculado desde casino_transactions (asignación, no suma)
 *   casino_sync_cursors  ← avanza solo sobre días cerrados y contiguos
 * y registra la corrida en casino_sync_runs / casino_sync_agent_ranges.
 *
 * Usage:
 *   node scripts/sync-casino-players-live.js --platform=zeus --auto
 *   node scripts/sync-casino-players-live.js --platform=zeus --auto --bootstrap-desde=2026-08-01
 *   node scripts/sync-casino-players-live.js --platform=zeus --desde=2026-05-01 --hasta=2026-05-12
 *   node scripts/sync-casino-players-live.js --platform=bet30 --agentes=btcuno,btcdos --desde=2026-09-01
 *   node scripts/sync-casino-players-live.js --platform=bet30 --desde=2025-01-01 --chunk-days=30 --concurrency=2
 *
 * Modo --auto: por cada agente, desde el último día cerrado cubierto de su cursor
 *   (--overlap-days, default 1) hasta hoy en hora Argentina. Un agente sin cursor
 *   falla con CURSOR_MISSING salvo que se pase --bootstrap-desde.
 * Modo rango (sin --auto): --desde (default 2020-01-01) a --hasta (default hoy ART).
 *
 * Preview (sin escrituras, corridas ni segmentación; válido durante mantenimiento):
 *   node scripts/sync-casino-players-live.js --preview --platform=zeus --agentes=betcoin --desde=2026-09-12 --hasta=2026-09-12
 * Requiere un único día YA cerrado y todas esas opciones explícitas. El reporte
 * calcula A/B/C; nunca autoriza ni ejecuta una importación. Ver sync/preview.js.
 *
 * Otros flags: --run-id=<uuid> (lo usa la API), --trigger=cli|api|pipeline.
 *
 * Códigos de salida: 0 éxito · 1 fallo o parcial · 2 argumentos inválidos ·
 *                    3 omitida (otra corrida de la plataforma en curso).
 *
 * Required env vars (per platform — see src/config/platforms.config.json):
 *   DATABASE_URL   conexión directa o pooler en modo sesión (usa advisory locks de sesión)
 *   ZEUS_API_KEY + ZEUS_ADMIN_USER/ZEUS_ADMIN_PASSWORD (o ZEUS_PLAYER_TOKEN)
 *   ZEUS_API_BASE  (optional — overrides config baseUrl)
 */

const { Pool }                               = require('pg')
const { createConnector, getDefaultPlatform } = require('../src/casino-connectors/index')
const { createLogger }                        = require('../src/lib/logger')
const { parseSyncArgs }                       = require('../src/casino-connectors/sync/cli-args')
const { runSync, EXIT }                       = require('../src/casino-connectors/sync/runner')

const parsed = parseSyncArgs(process.argv.slice(2), { defaultPlatform: getDefaultPlatform() })
if (!parsed.ok) {
  process.stderr.write(`${JSON.stringify({ level: 50, msg: 'Argumentos inválidos', errors: parsed.errors, component: 'sync' })}\n`)
  process.exit(EXIT.USAGE)
}

if (!process.env.DATABASE_URL) {
  // Logger not yet available — plain stderr before process.exit
  process.stderr.write('{"level":50,"msg":"DATABASE_URL is required","component":"sync"}\n')
  process.exit(EXIT.FAILED)
}

if (parsed.value.preview) {
  // Separate read-only path: runSync and its write/pause controls are untouched.
  const { runPreview, previewPoolOptions } = require('../src/casino-connectors/sync/preview')
  ;(async () => {
    let previewPool
    try {
      previewPool = new Pool(previewPoolOptions(process.env))
      previewPool.on('error', () => {}) // runPreview emits only sanitized failures
      const abort = new AbortController()
      for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => abort.abort())
      const result = await runPreview({ ...parsed.value, signal: abort.signal }, { pool: previewPool, createConnector })
      process.stdout.write(`${JSON.stringify(result)}\n`)
      process.exitCode = result.exitCode
    } catch {
      process.stderr.write('{"mode":"preview","read_only":true,"status":"failed","error_code":"PREVIEW_SETUP_FAILED"}\n')
      process.exitCode = EXIT.FAILED
    } finally {
      if (previewPool) await previewPool.end().catch(() => {})
    }
  })()
} else {
  const log = createLogger({ component: 'sync', platform: parsed.value.platform })

  const pool = new Pool({
    connectionString:             process.env.DATABASE_URL,
    keepAlive:                    true,
    keepAliveInitialDelayMillis:  10_000,
    connectionTimeoutMillis:      30_000,
    idleTimeoutMillis:            600_000,  // longer than the slowest Zeus API call
  })

  // Sin este listener, un corte de red en una conexión ociosa emite un 'error' sin
  // manejar en el pool y Node mata el proceso en el acto. Con el handler, la query
  // en curso falla, ese tramo queda registrado como fallido y el resto sigue.
  pool.on('error', err => {
    log.error({ code: err.code }, 'Idle DB connection error — el run continúa')
  })

  // SIGTERM/SIGINT: dejar de tomar tramos nuevos y cerrar la corrida como parcial.
  const abort = new AbortController()
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => {
      log.warn({ signal: sig }, 'Señal recibida — terminando después del tramo en curso')
      abort.abort()
    })
  }

  runSync({ ...parsed.value, signal: abort.signal }, { pool, createConnector, log })
    .then(result => {
      process.stdout.write(`${JSON.stringify({ runId: result.runId, status: result.status, exitCode: result.exitCode })}\n`)
      process.exitCode = result.exitCode
    })
    .catch(err => {
      log.error({ code: err?.code }, 'Fatal error')
      process.exitCode = EXIT.FAILED
    })
    .finally(() => pool.end().catch(() => {}))
}
