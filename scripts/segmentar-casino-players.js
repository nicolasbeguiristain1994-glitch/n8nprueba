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
 *   bajo      → < $100.000/mes activo
 *   medio     → $100.000 – $499.999/mes activo
 *   vip       → $500.000 – $999.999/mes activo  (VIP Bajo)
 *   vip_medio → $1.000.000 – $1.500.000/mes activo
 *   vip_alto  → $1.500.001 – $3.199.999/mes activo
 *   super_vip → >= $3.200.000/mes activo
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

const AGENTES = ['bigwin','ofizeus','betcoin','royal','farabet','zeus','zeusroyal','btcuno','btcdos']

// Umbrales de PROMEDIO MENSUAL sobre meses con actividad real (en pesos)
const THRESHOLD_MEDIO     =   100_000  // bajo      → < $100k/mes activo
const THRESHOLD_VIP       =   500_000  // medio     → $100k–$499k
const THRESHOLD_VIP_MEDIO = 1_000_000  // vip       → $500k–$999k
const THRESHOLD_VIP_ALTO  = 1_500_000  // vip_medio → $1M–$1.5M
const THRESHOLD_SUPER_VIP = 3_200_000  // vip_alto  → $1.5M–$3.2M  /  super_vip → >= $3.2M

// CTE que calcula meses activos, promedio mensual y FECHA REAL del último depósito
// usando casino_transactions (tipo='carga'). Usar casino_transactions como fuente
// de verdad para seg_actividad evita clasificar como "frecuente" a jugadores que
// tuvieron actividad hace meses y cuya casino_players.fecha_ultima esté desactualizada.
const CTE_MESES_ACTIVOS = `
  has_tx AS (
    SELECT EXISTS(SELECT 1 FROM casino_transactions WHERE tipo = 'carga') AS any_tx
  ),
  active_months AS (
    SELECT
      LOWER(ct.username)                                AS username_lower,
      COUNT(DISTINCT DATE_TRUNC('month', ct.fecha))::int AS meses_con_cargas,
      MAX(ct.fecha)::date                               AS last_tx_date
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
      )                                             AS avg_mensual,
      -- Si la sync ya corrió (casino_transactions tiene datos) pero este jugador
      -- no tiene registros, su última actividad es desconocida → NULL (perdido).
      -- Solo usamos casino_players.fecha_ultima como fallback si casino_transactions
      -- está completamente vacío (sync nunca ejecutada).
      CASE
        WHEN ht.any_tx AND am.last_tx_date IS NULL THEN NULL
        ELSE COALESCE(am.last_tx_date, cp.fecha_ultima)
      END                                          AS fecha_real_ultima
    FROM casino_players cp
    CROSS JOIN has_tx ht
    LEFT JOIN active_months am ON am.username_lower = cp.username_lower
    WHERE cp.agente = ANY($6::text[])
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
  console.log(`    bajo      →       $0  a  $${Number(THRESHOLD_MEDIO - 1).toLocaleString('es-AR')}/mes activo`)
  console.log(`    medio     → $${Number(THRESHOLD_MEDIO).toLocaleString('es-AR')}  a  $${Number(THRESHOLD_VIP - 1).toLocaleString('es-AR')}/mes activo`)
  console.log(`    vip       → $${Number(THRESHOLD_VIP).toLocaleString('es-AR')}  a  $${Number(THRESHOLD_VIP_MEDIO - 1).toLocaleString('es-AR')}/mes activo`)
  console.log(`    vip_medio → $${Number(THRESHOLD_VIP_MEDIO).toLocaleString('es-AR')}  a  $${Number(THRESHOLD_VIP_ALTO - 1).toLocaleString('es-AR')}/mes activo`)
  console.log(`    vip_alto  → $${Number(THRESHOLD_VIP_ALTO).toLocaleString('es-AR')}  a  $${Number(THRESHOLD_SUPER_VIP - 1).toLocaleString('es-AR')}/mes activo`)
  console.log(`    super_vip → $${Number(THRESHOLD_SUPER_VIP).toLocaleString('es-AR')}+/mes activo`)
  console.log('')

  if (DRY_RUN) {
    const previewRes = await pool.query(`
      WITH ${CTE_MESES_ACTIVOS}
      SELECT
        CASE
          WHEN cm.avg_mensual >= $1 THEN 'super_vip'
          WHEN cm.avg_mensual >= $2 THEN 'vip_alto'
          WHEN cm.avg_mensual >= $3 THEN 'vip_medio'
          WHEN cm.avg_mensual >= $4 THEN 'vip'
          WHEN cm.avg_mensual >= $5 THEN 'medio'
          ELSE                          'bajo'
        END AS seg_correcto,
        COUNT(*)::int AS n,
        ROUND(AVG(cm.avg_mensual)) AS avg_mensual_grupo,
        ROUND(AVG(cm.meses_activos), 1) AS avg_meses_activos
      FROM carga_mensual cm
      GROUP BY 1 ORDER BY 1
    `, [THRESHOLD_SUPER_VIP, THRESHOLD_VIP_ALTO, THRESHOLD_VIP_MEDIO, THRESHOLD_VIP, THRESHOLD_MEDIO, AGENTES])

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

      -- Usar fecha_real_ultima (de casino_transactions si hay datos, sino casino_players)
      dias_desde_ultimo = CASE
        WHEN cm.fecha_real_ultima IS NOT NULL THEN (CURRENT_DATE - cm.fecha_real_ultima)
        ELSE NULL
      END,

      seg_monto = CASE
        WHEN cm.avg_mensual >= $1 THEN 'super_vip'
        WHEN cm.avg_mensual >= $2 THEN 'vip_alto'
        WHEN cm.avg_mensual >= $3 THEN 'vip_medio'
        WHEN cm.avg_mensual >= $4 THEN 'vip'
        WHEN cm.avg_mensual >= $5 THEN 'medio'
        ELSE                          'bajo'
      END,

      -- seg_actividad usa fecha_real_ultima para no clasificar como activo
      -- a jugadores cuya casino_players.fecha_ultima esté desactualizada
      seg_actividad = CASE
        WHEN cm.fecha_real_ultima IS NULL
          OR (CURRENT_DATE - cm.fecha_real_ultima) > 180          THEN 'perdido'
        WHEN (CURRENT_DATE - cm.fecha_real_ultima) >  60          THEN 'inactivo'
        WHEN (CURRENT_DATE - cm.fecha_real_ultima) >  30          THEN 'en_riesgo'
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
  `, [THRESHOLD_SUPER_VIP, THRESHOLD_VIP_ALTO, THRESHOLD_VIP_MEDIO, THRESHOLD_VIP, THRESHOLD_MEDIO, AGENTES])

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

  // ── Paso 3: Sincronizar contact_tags de segmento desde casino_players ────────
  // Borra tags obsoletos y re-inserta los actuales para casino:actividad,
  // casino:antiguedad y casino:valor_riesgo. Esto corrige el drift que ocurre
  // cuando el segmento cambia pero los tags importados originalmente no se actualizan.
  await pool.query(`
    DELETE FROM contact_tags ct
    WHERE (ct.tag LIKE 'casino:actividad:%'
        OR ct.tag LIKE 'casino:antiguedad:%'
        OR ct.tag LIKE 'casino:valor_riesgo:%')
      AND ct.contact_id IN (
        SELECT c.id
        FROM contacts c
        JOIN casino_players cp ON LOWER(TRIM(c.first_name)) = cp.username_lower
        WHERE cp.agente = ANY($1::text[])
          AND cp.seg_monto IS NOT NULL
          AND cp.seg_actividad IS NOT NULL
      )
  `, [AGENTES])

  const tagsRes = await pool.query(`
    INSERT INTO contact_tags (id, contact_id, tag, added_by, added_at)
    SELECT
      gen_random_uuid(),
      c.id,
      unnest(array_remove(ARRAY[
        'casino:actividad:' || cp.seg_actividad,
        CASE
          WHEN cp.fecha_primera IS NULL                             THEN NULL
          WHEN (CURRENT_DATE - cp.fecha_primera) <  30             THEN 'casino:antiguedad:nuevo'
          WHEN (CURRENT_DATE - cp.fecha_primera) <  90             THEN 'casino:antiguedad:reciente'
          WHEN (CURRENT_DATE - cp.fecha_primera) < 150             THEN 'casino:antiguedad:establecido'
          WHEN (CURRENT_DATE - cp.fecha_primera) < 270             THEN 'casino:antiguedad:veterano'
          ELSE                                                           'casino:antiguedad:leal'
        END,
        CASE
          WHEN cp.seg_actividad IN ('perdido','inactivo','en_riesgo')
            AND cp.seg_monto IN ('super_vip','vip_alto','vip_medio','vip') THEN 'casino:valor_riesgo:critico'
          WHEN cp.seg_actividad IN ('perdido','inactivo','en_riesgo')
            AND cp.seg_monto = 'medio'                                     THEN 'casino:valor_riesgo:medio'
          WHEN cp.seg_actividad IN ('perdido','inactivo','en_riesgo')
            AND cp.seg_monto = 'bajo'                                      THEN 'casino:valor_riesgo:bajo'
          ELSE NULL
        END
      ], NULL)),
      NULL,
      NOW()
    FROM contacts c
    JOIN casino_players cp ON LOWER(TRIM(c.first_name)) = cp.username_lower
    WHERE cp.agente = ANY($1::text[])
      AND cp.seg_monto IS NOT NULL
      AND cp.seg_actividad IS NOT NULL
    ON CONFLICT (contact_id, tag) DO NOTHING
  `, [AGENTES])
  const syncedTags = tagsRes.rowCount ?? 0

  // ── Paso 4: Sincronizar contadores de depósitos en contacts ──────────────────
  // contacts.total_deposits y last_deposit_at se inicializan en 0/NULL y nunca
  // se actualizan automáticamente. Sin esta sincronización, el badge
  // "1er dep. · 10d+" puede aparecer en contactos que ya tienen muchos depósitos.
  const depositSyncRes = await pool.query(`
    UPDATE contacts c
    SET
      total_deposits    = cp.cant_cargas,
      total_withdrawals = cp.cant_retiros,
      last_deposit_at   = cp.fecha_ultima::timestamptz,
      updated_at        = NOW()
    FROM casino_players cp
    WHERE LOWER(TRIM(c.first_name)) = cp.username_lower
      AND cp.agente = ANY($1::text[])
      AND cp.fecha_ultima IS NOT NULL
      AND (
        c.total_deposits    IS DISTINCT FROM cp.cant_cargas
        OR c.total_withdrawals IS DISTINCT FROM cp.cant_retiros
        OR c.last_deposit_at::date IS DISTINCT FROM cp.fecha_ultima
      )
  `, [AGENTES])
  const syncedDeposits = depositSyncRes.rowCount ?? 0

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
  console.log(`  contact_tags resincronizados: ${Number(syncedTags).toLocaleString('es-AR')}`)
  console.log(`  contadores depósito sync'd:  ${Number(syncedDeposits).toLocaleString('es-AR')}`)
  console.log('  ✓  Segmentación completada.')
  console.log('')

  await pool.end()
}

main().catch(err => {
  console.error('\n[seg] Fatal:', err.message)
  pool.end()
  process.exit(1)
})
