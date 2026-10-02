#!/usr/bin/env node
'use strict'

/**
 * Pipeline diario de sincronización.
 *
 * Orden de ejecución:
 *   1. Sync Zeus  (casino_transactions + casino_players)
 *   2. Sync Bet30 (casino_transactions + casino_players)
 *   3. Segmentar  (contacts.last_deposit_at, segment, tags)
 *   4. Recompute prioridades (contact_priority_scores)
 *
 * Un sync que no termina con éxito (código ≠ 0: fallo, parcial u omitido) ya no
 * se trata como "continuar": las dos plataformas se intentan igual, pero si
 * alguna falló NO se segmenta ni se recalculan prioridades sobre datos
 * incompletos, y el pipeline sale con código 1. El detalle queda en
 * casino_sync_runs (Centro de Monitoreo, /monitoreo).
 *
 * Variables de entorno requeridas (Railway):
 *   DATABASE_URL
 *   ZEUS_ADMIN_USER / ZEUS_ADMIN_PASSWORD / ZEUS_API_KEY
 *   BET30_ADMIN_USER / BET30_ADMIN_PASSWORD / BET30_API_KEY
 *   CRON_APP_URL   — URL pública de la app (ej: https://xxx.up.railway.app)
 *   CRON_SECRET    — Secret compartido con el endpoint /api/contacts/recompute-priorities
 *
 * Uso manual:
 *   node scripts/pipeline-diario.js
 */

const { execFileSync } = require('child_process')
const path = require('path')
const fs   = require('fs')

// ── .env (solo para ejecución local) ─────────────────────────────────────────
const envPath = path.resolve(__dirname, '..', '.env')
if (fs.existsSync(envPath)) {
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const SEP = '═'.repeat(56)

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`)
}

/**
 * Corre un script con argv explícito (sin shell). Devuelve true solo si salió
 * con código 0. El mensaje de error no se loguea: puede traer la línea de
 * comando o salida del hijo; el hijo ya logueó su propio detalle sanitizado.
 */
function runScript(label, scriptName, args = []) {
  log(`\n${SEP}`)
  log(`  ${label}`)
  log(SEP)
  try {
    execFileSync(process.execPath, [path.join(__dirname, scriptName), ...args], {
      stdio: 'inherit',
      env:   process.env,
    })
    log(`✓  ${label} completado`)
    return true
  } catch (err) {
    log(`✗  ${label} falló (código ${err.status ?? 'desconocido'})`)
    return false
  }
}

async function recomputePriorities() {
  log(`\n${SEP}`)
  log('  Paso 4: Recompute prioridades')
  log(SEP)

  const appUrl = process.env.CRON_APP_URL?.trim()
  const secret = process.env.CRON_SECRET?.trim()

  if (!appUrl || !secret) {
    log('⚠  CRON_APP_URL o CRON_SECRET no configurados — omitiendo recompute automático')
    log('   Recomputá manualmente desde la UI: botón "Recomputar" en Prioridades')
    return
  }

  const res = await fetch(`${appUrl}/api/contacts/recompute-priorities`, {
    method:  'POST',
    headers: { 'x-cron-secret': secret, 'Content-Type': 'application/json' },
  })

  const body = await res.json()
  if (!res.ok) {
    // Solo el status: el cuerpo no se loguea.
    throw new Error(`Recompute HTTP ${res.status}`)
  }

  log(`✓  Recompute completado — ${body.eligible} elegibles de ${body.processed} contactos (${body.durationMs}ms)`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now()

  log(`\n${SEP}`)
  log('  Pipeline Diario')
  log(`  ${new Date().toISOString()}`)
  log(SEP)

  // Pasos 1 y 2: sync de transacciones del casino. Se intentan las dos
  // plataformas aunque una falle (cada una tiene su lock y su cursor), pero el
  // resultado se acumula: cualquier fallo corta los pasos 3 y 4.
  const zeusOk  = runScript('Paso 1: Sync Zeus',  'sync-casino-players-live.js', ['--platform=zeus',  '--auto', '--trigger=pipeline', '--agentes=betcoin,bigwin,farabet,ofizeus,royal'])
  const bet30Ok = runScript('Paso 2: Sync Bet30', 'sync-casino-players-live.js', ['--platform=bet30', '--auto', '--trigger=pipeline', '--agentes=btcuno,btcdos,zeus,zeusroyal,bigwin'])

  const mins = () => ((Date.now() - startMs) / 60_000).toFixed(1)

  if (!zeusOk || !bet30Ok) {
    log(`\n${SEP}`)
    log('  ✗  Sync incompleto — NO se segmenta ni se recalculan prioridades')
    log('     Revisar el detalle en /monitoreo (casino_sync_runs)')
    log(`  Pipeline terminado con errores en ${mins()} min`)
    log(`${SEP}\n`)
    process.exitCode = 1
    return
  }

  // Paso 3: calcular segmentos y sincronizar contacts.last_deposit_at
  if (!runScript('Paso 3: Segmentar jugadores', 'segmentar-casino-players.js', [])) {
    log('  ✗  Segmentación falló — no se recalculan prioridades')
    process.exitCode = 1
    return
  }

  // Paso 4: recalcular scores de prioridad
  try {
    await recomputePriorities()
  } catch (err) {
    // Mensajes propios ("Recompute HTTP n") o solo el tipo de error de red.
    log(`✗  Paso 4: Recompute falló: ${/^Recompute HTTP \d{3}$/.test(err.message) ? err.message : (err.name ?? 'error')}`)
    process.exitCode = 1
    return
  }

  log(`\n${SEP}`)
  log(`  ✓  Pipeline completado en ${mins()} min`)
  log(`${SEP}\n`)
}

main().catch(err => {
  log(`\nFATAL: error inesperado en el pipeline (${err?.name ?? 'error'})`)
  process.exit(1)
})
