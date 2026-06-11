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

function runScript(label, scriptName, args = [], { failOk = false } = {}) {
  log(`\n${SEP}`)
  log(`  ${label}`)
  log(SEP)
  try {
    execFileSync('node', [path.join(__dirname, scriptName), ...args], {
      stdio: 'inherit',
      env:   process.env,
    })
    log(`✓  ${label} completado`)
  } catch (err) {
    if (failOk) {
      log(`⚠  ${label} falló (continuando): ${err.message}`)
    } else {
      throw err
    }
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
    throw new Error(`Recompute HTTP ${res.status}: ${JSON.stringify(body)}`)
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

  // Pasos 1 y 2: sync de transacciones del casino
  // failOk=true: si una plataforma falla (credenciales vencidas, API caída),
  // el pipeline sigue y al menos actualiza la otra
  runScript('Paso 1: Sync Zeus',  'sync-casino-players-live.js', ['--platform=zeus',  '--auto', '--agentes=betcoin,bigwin,farabet,ofizeus,royal'], { failOk: true })
  runScript('Paso 2: Sync Bet30', 'sync-casino-players-live.js', ['--platform=bet30', '--auto', '--agentes=btcuno,btcdos,zeus,zeusroyal,bigwin'],  { failOk: true })

  // Paso 3: calcular segmentos y sincronizar contacts.last_deposit_at
  runScript('Paso 3: Segmentar jugadores', 'segmentar-casino-players.js', [], { failOk: true })

  // Paso 4: recalcular scores de prioridad
  try {
    await recomputePriorities()
  } catch (err) {
    log(`⚠  Paso 4: Recompute falló (continuando): ${err.message}`)
  }

  const mins = ((Date.now() - startMs) / 60_000).toFixed(1)
  log(`\n${SEP}`)
  log(`  ✓  Pipeline completado en ${mins} min`)
  log(`${SEP}\n`)
}

main().catch(err => {
  log(`\nFATAL: ${err.message}`)
  process.exit(1)
})
