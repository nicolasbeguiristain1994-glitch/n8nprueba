#!/usr/bin/env node
/**
 * segmentar-casino-players.js
 *
 * Calcula y aplica seg_monto + seg_actividad en casino_players.
 *
 * seg_monto — basado en PROMEDIO de cargas sobre meses CON actividad real
 * (meses donde el jugador hizo al menos una carga en casino_transactions).
 * No penaliza los meses que no jugó.
 *
 *   bajo       → < $250.000/mes activo
 *   medio      → $250.000 – $499.999/mes activo
 *   alto (Vip) → $500.000 – $999.999/mes activo
 *   vip (Super VIP) → >= $1.000.000/mes activo
 *
 * seg_actividad (sin cambios):
 *   perdido    → fecha_ultima > 180 días atrás (o NULL)
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

if (!process.env.DATABASE_URL) {
  console.error('[seg] ERROR: DATABASE_URL no configurada.')
  process.exit(1)
}

const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  connectionTimeoutMillis: 30_000,
  idleTimeoutMillis:       60_000,
})

const AGENTES = ['bigwin','ofizeus','betcoin','royal','farabet']

// Umbrales de PROMEDIO MENSUAL sobre meses con actividad real (en pesos)
const THRESHOLD_MEDIO = 250_000   // bajo  → < $250k/mes activo
const THRESHOLD_ALTO  = 500_000   // medio → $250k–$499k/mes activo
const THRESHOLD_VIP   = 1_000_000 // alto  → $500k–$999k/mes activo  /  vip → >= $1M/mes activo

// CTE que calcula meses activos y promedio mensual por jugador
// usando casino_transactions (tipo='carga'). Si no hay transacciones,
// el fallback es meses calendario entre fecha_primera y fecha_ultima.
const CTE_MESES_ACTIVOS = `
  active_months AS (
    SELECT
      LOWER(ct.username)                           AS username_lower,
      COUNT(DISTINCT DATE_TRUNC('month', ct.fecha))::int AS meses_con_cargas
    FROM casino_transactions ct
    WHERE ct.tipo = 'carga'
    GROUP BY LOWER(ct.username)
  ),
  carga_mensual AS (
    SELECT
      cp.id,
      cp.username_lower,
      cp.total_cargas,
      COALESCE(am.meses_con_cargas, 1)             AS meses_activos,
      ROUND(
        cp.total_cargas::numeric /
        GREATEST(COALESCE(am.meses_con_cargas, 1), 1)
      )                                             AS avg_mensual
    FROM casino_players cp
    LEFT JOIN active_months am ON am.username_lower = cp.username_lower
    WHERE cp.agente = ANY($4::text[])
  )
`

async function main() {
  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  casino_players — segmentación por promedio mensual de cargas')
  if (DRY_RUN) console.log('  *** DRY RUN — no se modificará nada ***')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('')
  console.log('  Criterio: promedio sobre meses CON actividad (no meses totales)')
  console.log('  Umbrales:')
  console.log(`    bajo       →       $0  a  $${Number(THRESHOLD_MEDIO - 1).toLocaleString('es-AR')}/mes activo`)
  console.log(`    medio      → $${Number(THRESHOLD_MEDIO).toLocaleString('es-AR')}  a  $${Number(THRESHOLD_ALTO - 1).toLocaleString('es-AR')}/mes activo`)
  console.log(`    alto (Vip) → $${Number(THRESHOLD_ALTO).toLocaleString('es-AR')}  a  $${Number(THRESHOLD_VIP - 1).toLocaleString('es-AR')}/mes activo`)
  console.log(`    vip (Super VIP) → $${Number(THRESHOLD_VIP).toLocaleString('es-AR')}+/mes activo`)
  console.log('')

  if (DRY_RUN) {
    const previewRes = await pool.query(`
      WITH ${CTE_MESES_ACTIVOS}
      SELECT
        CASE
          WHEN cm.avg_mensual >= $1 THEN 'vip'
          WHEN cm.avg_mensual >= $2 THEN 'alto'
          WHEN cm.avg_mensual >= $3 THEN 'medio'
          ELSE                          'bajo'
        END AS seg_correcto,
        COUNT(*)::int AS n,
        ROUND(AVG(cm.avg_mensual)) AS avg_mensual_grupo,
        ROUND(AVG(cm.meses_activos), 1) AS avg_meses_activos
      FROM carga_mensual cm
      GROUP BY 1 ORDER BY 1
    `, [THRESHOLD_VIP, THRESHOLD_ALTO, THRESHOLD_MEDIO, AGENTES])

    console.log('  DRY RUN — distribución estimada de seg_monto:')
    for (const r of previewRes.rows) {
      console.log(`    ${r.seg_correcto.padEnd(10)} ${Number(r.n).toLocaleString('es-AR').padStart(6)} jugadores  (avg $${Number(r.avg_mensual_grupo).toLocaleString('es-AR')}/mes · ${r.avg_meses_activos} meses activos prom.)`)
    }
    console.log('')
    console.log('  Volvé a correr sin --dry-run para aplicar.')
    await pool.end()
    return
  }

  // ── Paso 1: Actualizar casino_players ────────────────────────────────────────
  const updateRes = await pool.query(`
    WITH ${CTE_MESES_ACTIVOS}
    UPDATE casino_players cp
    SET
      freq_semanal = CASE
        WHEN cp.fecha_primera IS NOT NULL AND (CURRENT_DATE - cp.fecha_primera) > 0
          THEN ROUND(
            cp.cant_cargas::numeric
              / GREATEST((CURRENT_DATE - cp.fecha_primera)::numeric / 7.0, 1),
            2
          )
        ELSE 0
      END,

      dias_desde_ultimo = CASE
        WHEN cp.fecha_ultima IS NOT NULL THEN (CURRENT_DATE - cp.fecha_ultima)
        ELSE NULL
      END,

      seg_monto = CASE
        WHEN cm.avg_mensual >= $1 THEN 'vip'
        WHEN cm.avg_mensual >= $2 THEN 'alto'
        WHEN cm.avg_mensual >= $3 THEN 'medio'
        ELSE                          'bajo'
      END,

      seg_actividad = CASE
        WHEN cp.fecha_ultima IS NULL
          OR (CURRENT_DATE - cp.fecha_ultima) > 180               THEN 'perdido'
        WHEN (CURRENT_DATE - cp.fecha_ultima) >  60               THEN 'inactivo'
        WHEN (CURRENT_DATE - cp.fecha_ultima) >  30               THEN 'en_riesgo'
        WHEN cp.fecha_primera IS NOT NULL
          AND (CURRENT_DATE - cp.fecha_primera) <= 30             THEN 'nuevo'
        WHEN cp.fecha_primera IS NOT NULL
          AND (cp.cant_cargas::numeric
               / GREATEST((CURRENT_DATE - cp.fecha_primera)::numeric / 7.0, 1)) >= 3
                                                                  THEN 'frecuente'
        WHEN cp.fecha_primera IS NOT NULL
          AND (cp.cant_cargas::numeric
               / GREATEST((CURRENT_DATE - cp.fecha_primera)::numeric / 7.0, 1)) >= 1
                                                                  THEN 'regular'
        ELSE                                                           'ocasional'
      END,

      updated_at = NOW()
    FROM carga_mensual cm
    WHERE cm.id = cp.id
  `, [THRESHOLD_VIP, THRESHOLD_ALTO, THRESHOLD_MEDIO, AGENTES])

  const updatedPlayers = updateRes.rowCount ?? 0

  // ── Paso 2: Sincronizar contacts.segment desde casino_players ────────────────
  const syncRes = await pool.query(`
    UPDATE contacts c
    SET segment = cp.seg_monto::contact_segment
    FROM casino_players cp
    WHERE LOWER(TRIM(c.first_name)) = cp.username_lower
      AND cp.seg_monto IS NOT NULL
      AND c.segment::text != cp.seg_monto
  `)
  const syncedContacts = syncRes.rowCount ?? 0

  // ── Resultado ─────────────────────────────────────────────────────────────────
  const resultRes = await pool.query(`
    SELECT
      seg_monto,
      seg_actividad,
      COUNT(*)::int AS n
    FROM casino_players
    WHERE agente = ANY($1::text[])
    GROUP BY seg_monto, seg_actividad
    ORDER BY seg_monto, seg_actividad
  `, [AGENTES])

  const byMonto = {}
  const byAct   = {}
  for (const r of resultRes.rows) {
    byMonto[r.seg_monto]   = (byMonto[r.seg_monto]   || 0) + r.n
    byAct[r.seg_actividad] = (byAct[r.seg_actividad] || 0) + r.n
  }

  console.log('  Distribución seg_monto (tras corrección):')
  for (const [k, v] of Object.entries(byMonto).sort()) {
    console.log(`    ${k.padEnd(10)} ${Number(v).toLocaleString('es-AR')} jugadores`)
  }
  console.log('')
  console.log('  Distribución seg_actividad:')
  for (const [k, v] of Object.entries(byAct).sort()) {
    console.log(`    ${k.padEnd(12)} ${Number(v).toLocaleString('es-AR')} jugadores`)
  }

  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(`  casino_players actualizados: ${Number(updatedPlayers).toLocaleString('es-AR')}`)
  console.log(`  contacts sincronizados:      ${Number(syncedContacts).toLocaleString('es-AR')}`)
  console.log('  ✓  Segmentación completada.')
  console.log('')

  await pool.end()
}

main().catch(err => {
  console.error('\n[seg] Fatal:', err.message)
  pool.end()
  process.exit(1)
})
