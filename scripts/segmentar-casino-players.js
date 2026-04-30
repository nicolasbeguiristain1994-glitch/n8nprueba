#!/usr/bin/env node
/**
 * segmentar-casino-players.js
 *
 * Calcula y aplica seg_monto + seg_actividad en casino_players.
 *
 * Lógica idéntica a scripts/analizar-historial.js:
 *   seg_monto:     percentiles p33/p66/p90 de total_cargas sobre el dataset actual
 *   seg_actividad: reglas de días de inactividad + frecuencia semanal
 *
 * Reglas de seg_actividad:
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

const AGENTES = '{bigwin,ofizeus,betcoin,royal,farabet}'

async function main() {
  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  casino_players — segmentación dinámica (p33/p66/p90)')
  if (DRY_RUN) console.log('  *** DRY RUN — no se modificará nada ***')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('')

  // ── 1. Calcular thresholds percentiles ──────────────────────────────────────
  const thRes = await pool.query(`
    SELECT
      PERCENTILE_CONT(0.33) WITHIN GROUP (ORDER BY total_cargas)::bigint AS p33,
      PERCENTILE_CONT(0.66) WITHIN GROUP (ORDER BY total_cargas)::bigint AS p66,
      PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY total_cargas)::bigint AS p90,
      COUNT(*)::int AS total
    FROM casino_players
    WHERE agente = ANY($1::text[])
      AND total_cargas > 0
  `, [['bigwin','ofizeus','betcoin','royal','farabet']])

  const { p33, p66, p90, total } = thRes.rows[0]

  console.log(`  Jugadores con cargas > 0: ${Number(total).toLocaleString('es-AR')}`)
  console.log('')
  console.log('  Umbrales calculados del dataset actual:')
  console.log(`    bajo   →       $0  a  $${Number(p33).toLocaleString('es-AR')}`)
  console.log(`    medio  → $${Number(p33).toLocaleString('es-AR')}  a  $${Number(p66).toLocaleString('es-AR')}`)
  console.log(`    alto   → $${Number(p66).toLocaleString('es-AR')}  a  $${Number(p90).toLocaleString('es-AR')}`)
  console.log(`    vip    → $${Number(p90).toLocaleString('es-AR')}+`)
  console.log('')

  if (DRY_RUN) {
    // Preview: cuántos caerían en cada bucket sin modificar nada
    const previewRes = await pool.query(`
      SELECT
        CASE
          WHEN total_cargas >= $1 THEN 'vip'
          WHEN total_cargas >= $2 THEN 'alto'
          WHEN total_cargas >= $3 THEN 'medio'
          ELSE                         'bajo'
        END AS seg_monto,
        COUNT(*)::int AS n
      FROM casino_players
      WHERE agente = ANY($4::text[])
      GROUP BY 1 ORDER BY 1
    `, [p90, p66, p33, ['bigwin','ofizeus','betcoin','royal','farabet']])

    console.log('  DRY RUN — distribución estimada de seg_monto:')
    for (const r of previewRes.rows) {
      console.log(`    ${r.seg_monto.padEnd(10)} ${Number(r.n).toLocaleString('es-AR')} jugadores`)
    }
    console.log('')
    console.log('  Volvé a correr sin --dry-run para aplicar.')
    await pool.end()
    return
  }

  // ── 2. Aplicar segmentación en un solo UPDATE ────────────────────────────────
  //
  // seg_monto:    percentiles p33/p66/p90 de total_cargas del dataset completo
  // seg_actividad: reglas de días de inactividad + freq_semanal calculado en el mismo UPDATE
  //   perdido    → fecha_ultima IS NULL o > 180 días
  //   inactivo   → 61–180 días
  //   en_riesgo  → 31–60 días
  //   nuevo      → activo + fecha_primera ≤ 30 días
  //   frecuente  → activo + freq_semanal ≥ 3
  //   regular    → activo + freq_semanal ≥ 1
  //   ocasional  → activo + freq_semanal < 1

  const updateRes = await pool.query(`
    WITH thresholds AS (
      SELECT $1::bigint AS p33, $2::bigint AS p66, $3::bigint AS p90
    )
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
        WHEN cp.total_cargas >= t.p90 THEN 'vip'
        WHEN cp.total_cargas >= t.p66 THEN 'alto'
        WHEN cp.total_cargas >= t.p33 THEN 'medio'
        ELSE                               'bajo'
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
    FROM thresholds t
    WHERE cp.agente = ANY($4::text[])
  `, [p33, p66, p90, ['bigwin','ofizeus','betcoin','royal','farabet']])

  const updated = updateRes.rowCount ?? 0

  // ── 3. Resultado ─────────────────────────────────────────────────────────────
  const resultRes = await pool.query(`
    SELECT
      seg_monto,
      seg_actividad,
      COUNT(*)::int AS n
    FROM casino_players
    WHERE agente = ANY($1::text[])
    GROUP BY seg_monto, seg_actividad
    ORDER BY seg_monto, seg_actividad
  `, [['bigwin','ofizeus','betcoin','royal','farabet']])

  // Agrupar por seg_monto para resumen
  const byMonto = {}
  const byAct   = {}
  for (const r of resultRes.rows) {
    byMonto[r.seg_monto]   = (byMonto[r.seg_monto]   || 0) + r.n
    byAct[r.seg_actividad] = (byAct[r.seg_actividad] || 0) + r.n
  }

  console.log('  Distribución seg_monto:')
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
  console.log(`  Jugadores actualizados: ${Number(updated).toLocaleString('es-AR')}`)
  console.log('  ✓  Segmentación completada.')
  console.log('')

  await pool.end()
}

main().catch(err => {
  console.error('\n[seg] Fatal:', err.message)
  pool.end()
  process.exit(1)
})
