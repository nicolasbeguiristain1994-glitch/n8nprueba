#!/usr/bin/env node
'use strict'

/**
 * Pipeline diario de sincronización — fase 4.
 *
 * Orden de ejecución:
 *   1-4. Sync incremental (--auto) de las 4 plataformas (zeus, bet30, ganamos,
 *        argenbet), leyendo la lista de agentes de cada una desde
 *        src/config/platforms.config.json (getConfigAgents) — nunca
 *        hardcodeada acá ni inferida de la DB.
 *   5. Segmentar (contacts.last_deposit_at, segment, tags)
 *   6. Recompute prioridades (contact_priority_scores)
 *
 * Cada plataforma usa runOrchestrator() (scripts/lib/casino-sync-orchestrator.js)
 * IN-PROCESS, no un subproceso — el mismo advisory lock que protege al botón
 * manual y al endpoint /api/cron/casino-sync protege también esta corrida, y
 * el resultado es un objeto estructurado (no texto de stdout a parsear).
 *
 * Si una plataforma (o la segmentación, o el recompute de prioridades) falla,
 * las demás siguen — pero el proceso SIEMPRE termina con exit code != 0 si
 * CUALQUIERA falló. Un pipeline "verde" en los logs mientras algo realmente
 * falló es exactamente el bug que dejó el sync caído en silencio meses (ver
 * cabecera de la migración 123) — no se repite acá ni para el sync ni para
 * los pasos 5/6.
 *
 * Variables de entorno requeridas (Railway):
 *   DATABASE_URL
 *   Credenciales por plataforma — ver src/casino-connectors/README.md
 *   CRON_APP_URL   — URL pública de la app (ej: https://xxx.up.railway.app)
 *   CRON_SECRET    — Secret compartido con /api/contacts/recompute-priorities
 *                    y con /api/cron/casino-sync
 *
 * Uso manual:
 *   node scripts/pipeline-diario.js
 *
 * Nada de lo de abajo de `if (require.main === module)` corre al hacer
 * require() de este archivo — ni lectura de .env ni conexión a DB — así que
 * es seguro importarlo desde tests o desde el endpoint de cron.
 */

const path = require('path')
const fs   = require('fs')

function loadDotEnvOnce() {
  const envPath = path.resolve(__dirname, '..', '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    const k = t.slice(0, eq).trim()
    const v = t.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    if (!(k in process.env)) process.env[k] = v
  }
}

const SEP = '═'.repeat(56)

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`)
}

/**
 * Runs the incremental sync for all 4 configured platforms, in-process,
 * sequentially (platforms don't share an advisory lock key with each other,
 * so they COULD run concurrently, but sequential keeps DB load predictable
 * for a cron-driven pipeline and keeps this function trivial to reason
 * about/test).
 *
 * @param {object} deps injectable for tests
 * @returns {Promise<{platform: string, status: 'ok'|'error'|'skip', txInserted: number, lastTimestamp: string|null, error: string|null}[]>}
 */
async function runAllPlatformSyncs({ pool, log: logger = console, createConnector, clock } = {}) {
  const { runOrchestrator, recordPlatformFailure } = require('./lib/casino-sync-orchestrator')
  const { getConfigAgents }         = require('../src/casino-connectors/index')
  const { platforms }               = require('../src/config/platforms.config.json')

  const summaries = []

  for (const { name: platform } of platforms) {
    let agentes
    try {
      agentes = getConfigAgents(platform)
    } catch (err) {
      // getConfigAgents() throws BEFORE runOrchestrator() is ever called —
      // still needs to be visible in casino_sync_runs, not just in this
      // summary object, or a config typo fails silently from the DB's POV.
      let sanitized = err.message
      try {
        sanitized = await recordPlatformFailure(pool, platform, err, clock)
      } catch (bookkeepingErr) {
        logger.error?.({ platform, err: bookkeepingErr.message }, 'Could not record config-resolution failure either')
      }
      summaries.push({ platform, status: 'error', txInserted: 0, lastTimestamp: null, error: sanitized })
      continue
    }

    try {
      const result = await runOrchestrator({ platform, pool, agentes, auto: true, createConnector, clock, log: logger })

      if (result.skipped) {
        summaries.push({ platform, status: 'skip', txInserted: 0, lastTimestamp: null, error: null })
        continue
      }
      if (!result.ok && result.error) {
        // Platform-level failure (connector construction / authenticate())
        summaries.push({ platform, status: 'error', txInserted: 0, lastTimestamp: null, error: result.error })
        continue
      }

      const txInserted  = result.results.reduce((sum, r) => sum + (r.txInserted ?? 0), 0)
      const failedAgents = result.results.filter((r) => r.status === 'error')

      // `lastTimestamp` must reflect the newest transaction ACTUALLY
      // PERSISTED for this platform, not the requested `hasta` boundary of
      // any given agent's window — a window with zero new rows (or an
      // outright failed agent) would otherwise report "caught up to now"
      // even though nothing new landed in the database.
      const lastTimestamp = await _queryLastTimestamp(pool, platform)

      summaries.push({
        platform,
        status: result.ok ? 'ok' : 'error',
        txInserted,
        lastTimestamp,
        error: failedAgents.length
          ? failedAgents.map((r) => `${r.agente}: ${r.error}`).join(' | ')
          : null,
      })
    } catch (err) {
      summaries.push({ platform, status: 'error', txInserted: 0, lastTimestamp: null, error: err.message })
    }
  }

  return summaries
}

async function _queryLastTimestamp(pool, platform) {
  const { rows } = await pool.query(
    `SELECT MAX(fecha_hora_utc) AS last FROM casino_transactions WHERE platform = $1`,
    [platform],
  )
  const last = rows[0]?.last ?? null
  if (!last) return null
  return last instanceof Date ? last.toISOString() : String(last)
}

async function runSegmentacion() {
  const { execFileSync } = require('child_process')
  execFileSync(process.execPath, [path.join(__dirname, 'segmentar-casino-players.js')], { stdio: 'inherit', env: process.env })
}

async function runRecomputePrioridades() {
  const appUrl = process.env.CRON_APP_URL?.trim()
  const secret = process.env.CRON_SECRET?.trim()

  if (!appUrl || !secret) {
    log('⚠  CRON_APP_URL o CRON_SECRET no configurados — omitiendo recompute automático (paso opcional)')
    return { skipped: true }
  }

  const res  = await fetch(`${appUrl}/api/contacts/recompute-priorities`, {
    method:  'POST',
    headers: { 'x-cron-secret': secret, 'Content-Type': 'application/json' },
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`Recompute HTTP ${res.status}: ${JSON.stringify(body)}`)
  return body
}

/**
 * Full pipeline: 4 platform syncs + segmentación + recompute prioridades.
 * `deps.runSegmentacion`/`deps.runRecomputePrioridades` are injectable so
 * tests can exercise "step 5/6 failed" without actually spawning
 * segmentar-casino-players.js or hitting a real HTTP endpoint — defaults to
 * the real implementations above for production use.
 *
 * Returns `{ ok, platformSummaries, segmentacionError, prioridadesError }` —
 * `ok` is false if ANY step failed, including segmentación/prioridades
 * (previously these ran with `failOk: true` and their failure never
 * affected the exit code — fixed here per fase 4 brief).
 */
async function runPipeline(deps = {}) {
  const {
    runSegmentacion:        segmentacionFn = runSegmentacion,
    runRecomputePrioridades: prioridadesFn = runRecomputePrioridades,
    ...syncDeps
  } = deps

  const startMs = Date.now()
  log(`\n${SEP}`)
  log('  Pipeline Diario (fase 4 — 4 plataformas)')
  log(`  ${new Date().toISOString()}`)
  log(SEP)

  log('\nPasos 1-4: Sync incremental — zeus, bet30, ganamos, argenbet')
  const platformSummaries = await runAllPlatformSyncs(syncDeps)
  for (const s of platformSummaries) {
    log(`  ${s.platform.padEnd(10)} ${s.status.toUpperCase().padEnd(6)} tx=${s.txInserted} last=${s.lastTimestamp ?? '-'}${s.error ? ` error="${s.error}"` : ''}`)
  }

  let segmentacionError = null
  try {
    log('\nPaso 5: Segmentar jugadores')
    await segmentacionFn()
    log('✓  Segmentación completada')
  } catch (err) {
    segmentacionError = err.message
    log(`⚠  Segmentación falló: ${err.message}`)
  }

  let prioridadesError = null
  try {
    log('\nPaso 6: Recompute prioridades')
    const result = await prioridadesFn()
    if (!result.skipped) {
      log(`✓  Recompute completado — ${result.eligible} elegibles de ${result.processed} contactos (${result.durationMs}ms)`)
    }
  } catch (err) {
    prioridadesError = err.message
    log(`⚠  Recompute de prioridades falló: ${err.message}`)
  }

  const platformsFailed = platformSummaries.some((s) => s.status === 'error')
  const ok = !platformsFailed && !segmentacionError && !prioridadesError

  const mins = ((Date.now() - startMs) / 60_000).toFixed(1)
  log(`\n${SEP}`)
  log(`  ${ok ? '✓' : '✗'}  Pipeline ${ok ? 'completado' : 'con errores'} en ${mins} min`)
  log(`${SEP}\n`)

  return { ok, platformSummaries, segmentacionError, prioridadesError }
}

async function main() {
  loadDotEnvOnce()

  if (!process.env.DATABASE_URL) {
    log('FATAL: DATABASE_URL is required')
    process.exit(1)
  }

  const { Pool }          = require('pg')
  const { createLogger }  = require('../src/lib/logger')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 })
  const pinoLog = createLogger({ component: 'pipeline-diario' })

  let result
  try {
    result = await runPipeline({ pool, log: pinoLog })
  } finally {
    await pool.end()
  }

  // --json: emits the final structured summary as one marker line, so a
  // caller that only has the child's stdout (frontend/app/api/cron/casino-sync/route.ts,
  // which spawns this script rather than requiring it into the Next.js
  // server process) can recover the real per-platform result instead of
  // just the exit code.
  if (process.argv.includes('--json')) {
    process.stdout.write(`PIPELINE_RESULT_JSON:${JSON.stringify(result)}\n`)
  }

  process.exit(result.ok ? 0 : 1)
}

if (require.main === module) {
  main().catch((err) => {
    log(`\nFATAL: ${err.message}`)
    process.exit(1)
  })
}

module.exports = { runPipeline, runAllPlatformSyncs }
