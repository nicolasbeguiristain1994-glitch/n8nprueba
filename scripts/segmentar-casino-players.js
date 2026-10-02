#!/usr/bin/env node
/**
 * segmentar-casino-players.js
 *
 * Calcula y aplica seg_monto + seg_actividad en casino_players.
 *
 * seg_monto — basado en PROMEDIO de cargas sobre meses CON actividad real
 * (meses donde el jugador hizo al menos una carga en casino_transactions).
 * Sin transacciones se estima sobre el período histórico conocido.
 * No se mezcla el total histórico con los meses de una importación parcial.
 *
 *   bajo      → < $100.000/mes activo
 *   medio     → $100.000 – $499.999/mes activo
 *   vip       → $500.000 – $999.999/mes activo  (VIP Bajo)
 *   vip_medio → $1.000.000 – $1.499.999/mes activo
 *   vip_alto  → $1.500.000 – $3.199.999/mes activo
 *   super_vip → >= $3.200.000/mes activo
 *
 * seg_actividad:
 *   perdido    → fecha_ultima > 180 días atrás (NULL = desconocido)
 *   inactivo   → fecha_ultima 61–180 días atrás
 *   en_riesgo  → fecha_ultima 31–60 días atrás
 *   nuevo      → fecha_primera ≤ 30 días atrás (y activo)
 *   frecuente  → activo + freq_semanal ≥ 3
 *   regular    → activo + freq_semanal ≥ 1
 *   ocasional  → activo + freq_semanal < 1
 *
 * Idempotente: puede correrse múltiples veces.
 *
 * Uso:
 *   node scripts/segmentar-casino-players.js
 *   node scripts/segmentar-casino-players.js --dry-run
 *   DATABASE_URL="postgresql://..." node scripts/segmentar-casino-players.js
 */

'use strict'

const { Pool } = require('pg')
const fs       = require('fs')
const path     = require('path')

// ── .env ──────────────────────────────────────────────────────────────────────
;(function loadDotEnv() {
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
})()

const DRY_RUN = process.argv.includes('--dry-run')
const IMPORTED_ONLY = process.argv.includes('--imported-only')

// seg_monto usa importes y meses del mismo historial:
// no depende de qué día es hoy, así que es seguro recalcularlo aunque la sync
// del casino esté atrasada. seg_actividad sí depende de CURRENT_DATE — si los
// datos vienen con semanas de retraso, marca como "perdido" a gente que sigue
// jugando. Con --skip-actividad se actualiza solo el valor y se dejan intactos
// la actividad y sus tags, para recalcularlos después de resincronizar.
const SKIP_ACTIVIDAD = process.argv.includes('--skip-actividad')

if (!process.env.DATABASE_URL) {
  console.error('[seg] ERROR: DATABASE_URL no configurada.')
  process.exit(1)
}

const pool = new Pool({
  max: 1,
  connectionString:        process.env.DATABASE_URL,
  connectionTimeoutMillis: 30_000,
  idleTimeoutMillis:       60_000,
})

const { prepareSegmentation, applySegmentation, activityPreservationPlatforms } = require('../frontend/lib/casino-segmentation')

async function main() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL TIME ZONE 'America/Argentina/Buenos_Aires'")
    await client.query("SELECT pg_advisory_xact_lock(hashtext('casino-segmentation'))")
    await client.query("SET LOCAL statement_timeout='300s'")
    const summary = await prepareSegmentation(client, { importedOnly: IMPORTED_ONLY })
    console.log(JSON.stringify({ dry_run: DRY_RUN, ...summary }, null, 2))
    console.table((await client.query(`SELECT segment,activity,COUNT(*)::int AS contacts
      FROM seg_contact_profile GROUP BY segment,activity ORDER BY segment,activity`)).rows)
    if (DRY_RUN) {
      await client.query('ROLLBACK')
      console.log('DRY RUN: no se modificaron contactos ni jugadores.')
    } else {
      await applySegmentation(client, { skipActivity: SKIP_ACTIVIDAD, updatePlayers: !IMPORTED_ONLY, preserveActivityPlatforms: activityPreservationPlatforms() })
      await client.query('COMMIT')
      console.log('Segmentación completada.')
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}
main().catch(err => { console.error('[seg]', err.message); process.exitCode = 1 })
