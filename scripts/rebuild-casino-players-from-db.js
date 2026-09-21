#!/usr/bin/env node
/**
 * rebuild-casino-players-from-db.js
 *
 * Reconstruye casino_players a partir de casino_transactions ya almacenadas.
 * No requiere acceso a la API de Zeus — usa los datos ya seedeados en la BD.
 * Idempotente: puede ejecutarse múltiples veces sin duplicar jugadores.
 *
 * Cuándo usarlo:
 *   - Casino_transactions está poblada pero casino_players está vacía
 *   - Bootstrap en un entorno nuevo sin credenciales de Zeus
 *   - Re-sincronización forzada después de un reset de casino_players
 *
 * CAMBIO (fase 1, migración 127 — D2): este script fusionaba zeus+bet30 en una
 * sola fila por username (comentario original: "un jugador con el mismo
 * username en Zeus y en Bet30 es la misma persona"). Eso dejó de ser viable:
 * la identidad de casino_players pasó a ser (platform, username_lower), y el
 * índice único global que este script usaba (`ON CONFLICT (username_lower)`)
 * ya no existe — la migración 127 lo reemplaza por uno compuesto. Se reescribe
 * para producir UNA fila por plataforma, igual que
 * BaseCasinoConnector.recomputePlayers(): agrega y sube zeus por separado de
 * bet30, sin fusionarlos. Si de verdad hace falta una vista "misma persona en
 * las dos plataformas", esa es una decisión de producto para una fase
 * posterior (persona vs. jugador, ver plan §8.2), no algo que casino_players
 * deba resolver silenciosamente en un script de bootstrap.
 *
 * Semántica compartida con sync-casino-players-live.js / recomputePlayers():
 *   - Excluye filas donde username = agente (Carga/Retiro indirecto)
 *   - fecha_primera/fecha_ultima consideran solo depósitos (tipo='carga')
 *   - ON CONFLICT (platform, username_lower) DO UPDATE, asignación no suma
 *
 * Uso:
 *   node scripts/rebuild-casino-players-from-db.js
 *   node scripts/rebuild-casino-players-from-db.js --dry-run
 *   node scripts/rebuild-casino-players-from-db.js --agentes=farabet,betcoin
 *
 * Variables de entorno requeridas:
 *   DATABASE_URL  — conexión a Postgres (se lee también del .env raíz)
 */

'use strict'

const { Pool } = require('pg')
const fs       = require('fs')
const path     = require('path')

// ── Carga .env del directorio raíz ────────────────────────────────────────────

;(function loadDotEnv() {
  const envPath = path.resolve(__dirname, '..', '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    if (!(key in process.env)) process.env[key] = val
  }
})()

// ── Config ────────────────────────────────────────────────────────────────────

// Listas propias por plataforma (mismos nombres que
// frontend/lib/casino-agents.ts PLATFORM_AGENTS) — ya NO se fusionan.
const AGENTES_POR_PLATAFORMA = {
  zeus:  ['bigwin', 'ofizeus', 'betcoin', 'royal', 'farabet', 'lasvegas'],
  bet30: ['bigwin', 'zeus', 'zeusroyal', 'btcuno', 'btcdos'],
}
const AGENTES_PERMITIDOS = [...new Set(Object.values(AGENTES_POR_PLATAFORMA).flat())]

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? 'true'] })
)

const DRY_RUN      = args['dry-run'] === 'true'
const AGENTES_FILTRO = args.agentes
  ? args.agentes.split(',').map(a => a.trim()).filter(a => AGENTES_PERMITIDOS.includes(a))
  : null // null = todos

/** Agentes de esta plataforma, recortados por --agentes si se pasó. */
function agentesDePlataforma(platform) {
  const propios = AGENTES_POR_PLATAFORMA[platform]
  return AGENTES_FILTRO ? propios.filter(a => AGENTES_FILTRO.includes(a)) : propios
}

// ── Pool ──────────────────────────────────────────────────────────────────────

if (!process.env.DATABASE_URL) {
  console.error('[rebuild] ERROR: DATABASE_URL no está configurada.')
  console.error('[rebuild]   Definila en .env o exportala antes de correr el script.')
  process.exit(1)
}

const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  connectionTimeoutMillis: 30_000,
  idleTimeoutMillis:       60_000,
})

// ── Rebuild de una plataforma ─────────────────────────────────────────────────
//
// Semántica idéntica a BaseCasinoConnector.recomputePlayers():
//   - Excluye username = agente (carga/retiro indirecto)
//   - fecha_primera/fecha_ultima consideran solo depósitos (tipo='carga')
//   - ON CONFLICT (platform, username_lower) DO UPDATE, asignación no suma
//
// seg_monto / seg_actividad intencionalmente NO se tocan acá — eso lo hace
// segmentar-casino-players.js.
async function rebuildPlatform(platform, agentes) {
  if (!agentes.length) return { affectedRows: 0, players: [] }

  const srcRes = await pool.query(
    `SELECT agente, COUNT(*) AS tx_count
     FROM casino_transactions
     WHERE platform = $1 AND agente = ANY($2::text[]) AND username != agente
     GROUP BY agente ORDER BY agente`,
    [platform, agentes]
  )

  if (srcRes.rows.length === 0) {
    console.log(`  [${platform}] ⚠  Sin transacciones con platform='${platform}' para estos agentes.`)
    console.log(`  [${platform}]    Si son datos previos a la migración 127, corré esa migración`)
    console.log(`  [${platform}]    primero — ella backfillea platform en casino_transactions.`)
    return { affectedRows: 0, players: [] }
  }

  console.log(`  [${platform}] Transacciones fuente:`)
  for (const r of srcRes.rows) {
    console.log(`    ${r.agente.padEnd(10)}  ${Number(r.tx_count).toLocaleString('es-AR')} tx`)
  }

  if (DRY_RUN) {
    const previewRes = await pool.query(
      `SELECT COUNT(DISTINCT LOWER(username)) AS player_count
       FROM casino_transactions
       WHERE platform = $1 AND agente = ANY($2::text[]) AND username != agente`,
      [platform, agentes]
    )
    console.log(`  [${platform}] Se procesarían ~${previewRes.rows[0].player_count} jugadores únicos.`)
    return { affectedRows: 0, players: [] }
  }

  const upsertRes = await pool.query(
    `WITH agregado AS (
       SELECT
         (array_agg(username ORDER BY COALESCE(fecha_hora_utc, fecha::timestamptz) DESC, id DESC))[1] AS username,
         (array_agg(agente   ORDER BY COALESCE(fecha_hora_utc, fecha::timestamptz) DESC, id DESC))[1] AS agente,
         COALESCE(SUM(monto) FILTER (WHERE tipo = 'carga'),  0)::numeric(20,2) AS total_cargas,
         COALESCE(SUM(monto) FILTER (WHERE tipo = 'retiro'), 0)::numeric(20,2) AS total_retiros,
         COUNT(*) FILTER (WHERE tipo = 'carga')::int  AS cant_cargas,
         COUNT(*) FILTER (WHERE tipo = 'retiro')::int AS cant_retiros,
         MIN(fecha) FILTER (WHERE tipo = 'carga') AS fecha_primera,
         MAX(fecha) FILTER (WHERE tipo = 'carga') AS fecha_ultima
       FROM casino_transactions
       WHERE platform = $1 AND agente = ANY($2::text[]) AND username != agente
       GROUP BY LOWER(username)
     )
     INSERT INTO casino_players
       (username, agente, platform,
        total_cargas, total_retiros, cant_cargas, cant_retiros,
        fecha_primera, fecha_ultima)
     SELECT
       a.username, a.agente, $1,
       a.total_cargas, a.total_retiros, a.cant_cargas, a.cant_retiros,
       a.fecha_primera, a.fecha_ultima
     FROM agregado a
     ON CONFLICT (platform, username_lower) DO UPDATE SET
       agente        = EXCLUDED.agente,
       total_cargas  = EXCLUDED.total_cargas,
       total_retiros = EXCLUDED.total_retiros,
       cant_cargas   = EXCLUDED.cant_cargas,
       cant_retiros  = EXCLUDED.cant_retiros,
       fecha_primera = EXCLUDED.fecha_primera,
       fecha_ultima  = EXCLUDED.fecha_ultima,
       updated_at    = NOW()`,
    [platform, agentes]
  )

  const resultRes = await pool.query(
    `SELECT agente, COUNT(*) AS players
     FROM casino_players
     WHERE platform = $1 AND agente = ANY($2::text[])
     GROUP BY agente ORDER BY agente`,
    [platform, agentes]
  )

  console.log(`  [${platform}] Jugadores en casino_players tras el rebuild:`)
  for (const r of resultRes.rows) {
    console.log(`    ${r.agente.padEnd(10)}  ${Number(r.players).toLocaleString('es-AR')} jugadores`)
  }
  const sinResultado = agentes.filter(a => !resultRes.rows.find(r => r.agente === a))
  if (sinResultado.length) {
    console.log(`  [${platform}] ⚠  Sin jugadores resultantes para: ${sinResultado.join(', ')}`)
  }

  return { affectedRows: upsertRes.rowCount ?? 0, players: resultRes.rows }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  casino_players — rebuild desde casino_transactions (por plataforma)')
  if (DRY_RUN) console.log('  *** DRY RUN — no se modificará nada ***')
  console.log('═══════════════════════════════════════════════════════════════')

  let totalAffected = 0
  let totalPlayers  = 0

  for (const platform of Object.keys(AGENTES_POR_PLATAFORMA)) {
    const agentes = agentesDePlataforma(platform)
    console.log('')
    console.log(`  Plataforma: ${platform} — agentes: ${agentes.join(', ') || '(ninguno tras --agentes)'}`)
    if (!agentes.length) continue

    const { affectedRows, players } = await rebuildPlatform(platform, agentes)
    totalAffected += affectedRows
    totalPlayers  += players.reduce((s, r) => s + Number(r.players), 0)
  }

  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  RESUMEN')
  console.log('═══════════════════════════════════════════════════════════════')
  if (DRY_RUN) {
    console.log('  Volvé a correr sin --dry-run para ejecutar.')
  } else {
    console.log(`  Filas insertadas/actualizadas: ${totalAffected.toLocaleString('es-AR')}`)
    console.log(`  Total jugadores en casino_players: ${totalPlayers.toLocaleString('es-AR')}`)
    console.log('')
    console.log('  ✓  Rebuild completado.')
    console.log('')
    console.log('  Próximos pasos:')
    console.log('  • Para segmentación (seg_monto/seg_actividad):')
    console.log('      node scripts/segmentar-casino-players.js')
    console.log('  • Para sync incremental futuro:')
    console.log('      node scripts/sync-casino-players-live.js --auto')
  }
  console.log('')

  await pool.end()
}

main().catch(err => {
  console.error('\n[rebuild] Fatal:', err.message)
  pool.end()
  process.exit(1)
})
