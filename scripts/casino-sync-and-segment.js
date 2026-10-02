#!/usr/bin/env node
'use strict'

/**
 * Encadena sync de casino → segmentación, sin shell.
 *
 * Lo lanza POST /api/dashboard/casino/sync con argv explícito (nunca se
 * interpolan parámetros del usuario en un comando de shell). Recibe los mismos
 * flags que sync-casino-players-live.js y exige --run-id.
 *
 * La segmentación corre SOLO si el sync salió con código 0. Un sync parcial,
 * fallido u omitido deja segmentation_status = 'skipped' en casino_sync_runs y
 * este proceso sale con el mismo código que el sync.
 *
 * Uso:
 *   node scripts/casino-sync-and-segment.js --run-id=<uuid> --platform=zeus --auto
 */

const { spawn } = require('child_process')
const path      = require('path')
const { Pool }  = require('pg')

const { parseSyncArgs }     = require('../src/casino-connectors/sync/cli-args')
const { SyncRunStore }      = require('../src/casino-connectors/sync/SyncRunStore')
const { EXIT }              = require('../src/casino-connectors/sync/runner')
const { createLogger }      = require('../src/lib/logger')

const SYNC_SCRIPT = path.join(__dirname, 'sync-casino-players-live.js')
const SEG_SCRIPT  = path.join(__dirname, 'segmentar-casino-players.js')

const argv   = process.argv.slice(2)
const parsed = parseSyncArgs(argv)
const log    = createLogger({ component: 'sync-chain' })

if (!parsed.ok || !parsed.value.runId) {
  log.error({ errors: parsed.ok ? ['--run-id es obligatorio'] : parsed.errors }, 'Argumentos inválidos')
  process.exit(EXIT.USAGE)
}

const runId = parsed.value.runId
let current = null

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => { if (current) current.kill(sig) })
}

function runNode(script, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit', env: process.env })
    current = child
    child.on('error', err => { current = null; resolve({ code: EXIT.FAILED, spawnError: err.code ?? 'SPAWN_ERROR' }) })
    child.on('close', code => { current = null; resolve({ code: code ?? EXIT.FAILED }) })
  })
}

async function main() {
  const pool  = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 2 }) : null
  const store = pool ? new SyncRunStore(pool) : null
  let exitCode = EXIT.FAILED

  const setSeg = async status => {
    if (!store) return false
    try {
      const updated = await store.setSegmentationStatus(runId, status)
      if (!updated) log.error({ runId, status, alert: true }, 'La corrida no estaba en el estado esperado para registrar la segmentación')
      return updated
    } catch (err) {
      log.error({ runId, status, code: err.code, alert: true }, 'No se pudo registrar el estado de la segmentación')
      return false
    }
  }

  try {
    const sync = await runNode(SYNC_SCRIPT, argv)

    if (sync.code !== EXIT.SUCCESS) {
      // No se toca la fila: si el run_id fue reutilizado, pertenece a otra
      // corrida. Cuando es propia, el runner ya marcó la segmentación 'skipped'.
      log.error({ runId, syncExit: sync.code, spawnError: sync.spawnError, alert: true },
        'Sync sin éxito — la segmentación NO se ejecuta')
      exitCode = sync.code
      return
    }

    const recorded = await setSeg('running')
    if (!recorded) {
      // Sin registro del inicio no se ejecuta una segunda fase sin trazabilidad.
      log.error({ runId, alert: true }, 'No se inicia la segmentación: no se pudo registrar su inicio')
      return
    }
    const seg      = await runNode(SEG_SCRIPT, [])
    const segOk    = seg.code === 0
    const closed   = await setSeg(segOk ? 'success' : 'failed')

    if (!segOk) log.error({ runId, segExit: seg.code, alert: true }, 'Segmentación falló')
    exitCode = segOk && recorded && closed ? EXIT.SUCCESS : EXIT.FAILED
  } finally {
    if (pool) await pool.end().catch(() => {})
    process.exitCode = exitCode
  }
}

main().catch(err => {
  log.error({ runId, code: err?.code, alert: true }, 'Error inesperado en la cadena sync → segmentación')
  process.exitCode = EXIT.FAILED
})
