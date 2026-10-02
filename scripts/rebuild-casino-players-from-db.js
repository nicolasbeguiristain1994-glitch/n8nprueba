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
 * Semántica idéntica a sync-casino-players-live.js:
 *   - Excluye filas donde username = agente (Carga/Retiro indirecto)
 *   - Usa LEAST(fecha_primera) y GREATEST(fecha_ultima) en conflictos
 *   - ON CONFLICT (username_lower) DO UPDATE (upsert seguro)
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

// El mismo operador opera en las dos plataformas bajo nombres distintos:
//   Zeus     betcoin   farabet   ofizeus   bigwin   royal
//   Bet30    btcuno    btcdos    zeus      bigwin   zeusroyal
// Ambos juegos de nombres son válidos como `agente` en casino_transactions.
const AGENTES_PERMITIDOS = [
  'bigwin', 'ofizeus', 'betcoin', 'royal', 'farabet',   // Zeus
  'btcuno', 'btcdos', 'zeus', 'zeusroyal',              // Bet30 (bigwin se repite)
]

// Un mismo operador se llama distinto en cada plataforma. casino_transactions
// guarda el nombre real con que vino de cada casino —eso preserva la trazabilidad—
// y acá se unifica al nombre de Zeus, que es el que usa el resto de la app:
// contacts.panel, los filtros de la UI y la visibilidad por agente.
const ALIAS_AGENTE = {
  btcuno:    'betcoin',
  btcdos:    'farabet',
  zeus:      'ofizeus',
  zeusroyal: 'royal',
}

const ALIAS_SQL = Object.entries(ALIAS_AGENTE)
  .map(([de, a]) => `WHEN '${de}' THEN '${a}'`)
  .join(' ')

/** Expresión SQL que traduce un nombre de agente de Bet30 al de Zeus. */
const AGENTE_NORMALIZADO = `CASE LOWER(TRIM(ct.agente)) ${ALIAS_SQL} ELSE LOWER(TRIM(ct.agente)) END`

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? 'true'] })
)

const DRY_RUN    = args['dry-run'] === 'true'
const AGENTES    = args.agentes
  ? args.agentes.split(',').map(a => a.trim()).filter(a => AGENTES_PERMITIDOS.includes(a))
  : AGENTES_PERMITIDOS

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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  casino_players — rebuild desde casino_transactions')
  if (DRY_RUN) console.log('  *** DRY RUN — no se modificará nada ***')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(`  Agentes: ${AGENTES.join(', ')}`)
  console.log('')

  // ── Verificar fuente ─────────────────────────────────────────────────────────
  const srcRes = await pool.query(
    `SELECT agente, COUNT(*) AS tx_count
     FROM casino_transactions
     WHERE agente = ANY($1::text[])
       AND username != agente
     GROUP BY agente ORDER BY agente`,
    [AGENTES]
  )

  if (srcRes.rows.length === 0) {
    console.log('  ⚠  Sin transacciones en casino_transactions para estos agentes.')
    console.log('     Verificá que el seed se ejecutó primero:')
    console.log('       node scripts/seed-casino-transactions.js')
    await pool.end()
    return
  }

  console.log('  Transacciones fuente en casino_transactions:')
  for (const r of srcRes.rows) {
    console.log(`    ${r.agente.padEnd(10)}  ${Number(r.tx_count).toLocaleString('es-AR')} tx`)
  }
  console.log('')

  // ── DRY RUN — preview ────────────────────────────────────────────────────────
  if (DRY_RUN) {
    const previewRes = await pool.query(
      `SELECT COUNT(DISTINCT LOWER(ct.username)) AS player_count
       FROM casino_transactions ct
       WHERE ct.agente = ANY($1::text[])
         AND ct.username != ct.agente`,
      [AGENTES]
    )
    console.log(`  Se procesarían ~${previewRes.rows[0].player_count} jugadores únicos.`)
    console.log('  Volvé a correr sin --dry-run para ejecutar.')
    await pool.end()
    return
  }

  // ── Upsert casino_players desde casino_transactions ───────────────────────────
  //
  // Semántica idéntica a sync-casino-players-live.js upsert():
  //   - Agrega cargas/retiros por (username, agente)
  //   - LEAST(fecha_primera) preserva la fecha de actividad más antigua
  //   - GREATEST(fecha_ultima) preserva la última actividad
  //   - ON CONFLICT (username_lower) DO UPDATE para seguridad de upsert
  //
  // seg_monto / seg_actividad intencionalmente NO se tocan:
  //   - Si hay valores previos (de un sync anterior), se preservan
  //   - Si son NULL (primera carga), quedan NULL hasta que se corra segmentación
  //   - El dashboard los muestra como '' vía COALESCE y sigue funcionando

  const upsertRes = await pool.query(
    // Se agrupa por username, NO por (username, agente).
    //
    // Un jugador con el mismo username en Zeus y en Bet30 es la misma persona, y
    // su valor real es la suma de lo que cargó en las dos. Agrupando por
    // (username, agente) salían dos filas que chocaban en el índice único de
    // username_lower y se pisaban entre sí vía ON CONFLICT: el jugador terminaba
    // con los datos de una sola plataforma, la que se procesara último, y el
    // resultado dependía del orden del GROUP BY.
    //
    // `agente` se resuelve aparte: el de su transacción más reciente, porque ese
    // campo se usa para saber por dónde contactarlo.
    `WITH agente_reciente AS (
       SELECT DISTINCT ON (LOWER(ct.username))
              LOWER(ct.username)    AS uname,
              ${AGENTE_NORMALIZADO} AS agente,
              ct.username           AS username_original
       FROM casino_transactions ct
       WHERE ct.agente = ANY($1::text[])
         AND ct.username != ct.agente
       ORDER BY LOWER(ct.username), ct.fecha DESC, ct.id DESC
     ),
     agregado AS (
       SELECT
         LOWER(ct.username) AS uname,
         COALESCE(SUM(ct.monto) FILTER (WHERE ct.tipo = 'carga'),  0)::bigint AS total_cargas,
         COALESCE(SUM(ct.monto) FILTER (WHERE ct.tipo = 'retiro'), 0)::bigint AS total_retiros,
         COALESCE(COUNT(*)      FILTER (WHERE ct.tipo = 'carga'),  0)::int    AS cant_cargas,
         COALESCE(COUNT(*)      FILTER (WHERE ct.tipo = 'retiro'), 0)::int    AS cant_retiros,
         MIN(ct.fecha) AS fecha_primera,
         MAX(ct.fecha) AS fecha_ultima
       FROM casino_transactions ct
       WHERE ct.agente = ANY($1::text[])
         AND ct.username != ct.agente
       GROUP BY LOWER(ct.username)
       HAVING
         SUM(ct.monto) FILTER (WHERE ct.tipo = 'carga')  > 0
         OR SUM(ct.monto) FILTER (WHERE ct.tipo = 'retiro') > 0
     )
     INSERT INTO casino_players
       (username, agente,
        total_cargas, total_retiros, cant_cargas, cant_retiros,
        fecha_primera, fecha_ultima)
     SELECT
       ar.username_original,
       ar.agente,
       a.total_cargas, a.total_retiros, a.cant_cargas, a.cant_retiros,
       a.fecha_primera, a.fecha_ultima
     FROM agregado a
     JOIN agente_reciente ar ON ar.uname = a.uname
     ON CONFLICT (username_lower) DO UPDATE SET
       agente        = EXCLUDED.agente,
       total_cargas  = EXCLUDED.total_cargas,
       total_retiros = EXCLUDED.total_retiros,
       cant_cargas   = EXCLUDED.cant_cargas,
       cant_retiros  = EXCLUDED.cant_retiros,
       fecha_primera = LEAST(casino_players.fecha_primera,   EXCLUDED.fecha_primera),
       fecha_ultima  = GREATEST(casino_players.fecha_ultima, EXCLUDED.fecha_ultima),
       updated_at    = NOW()`,
    [AGENTES]
  )

  const affectedRows = upsertRes.rowCount ?? 0

  // ── Resultado por agente ──────────────────────────────────────────────────────
  const resultRes = await pool.query(
    `SELECT agente, COUNT(*) AS players
     FROM casino_players
     WHERE agente = ANY($1::text[])
     GROUP BY agente ORDER BY agente`,
    [AGENTES]
  )

  console.log('  Jugadores en casino_players tras el rebuild:')
  let totalPlayers = 0
  for (const r of resultRes.rows) {
    console.log(`    ${r.agente.padEnd(10)}  ${Number(r.players).toLocaleString('es-AR')} jugadores`)
    totalPlayers += Number(r.players)
  }

  // Comparar contra los nombres ya unificados: pedir 'btcuno' produce filas bajo
  // 'betcoin', y sin traducir el aviso diría que no tuvo resultado.
  const esperados = [...new Set(AGENTES.map(a => ALIAS_AGENTE[a] ?? a))]
  const agentesSinResultado = esperados.filter(a => !resultRes.rows.find(r => r.agente === a))
  if (agentesSinResultado.length) {
    console.log(`  ⚠  Sin jugadores resultantes para: ${agentesSinResultado.join(', ')}`)
  }

  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  RESUMEN')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(`  Filas insertadas/actualizadas: ${affectedRows.toLocaleString('es-AR')}`)
  console.log(`  Total jugadores en casino_players: ${totalPlayers.toLocaleString('es-AR')}`)
  console.log('')
  console.log('  ✓  Rebuild completado.')
  console.log('')
  console.log('  Próximos pasos:')
  console.log('  • Para segmentación (seg_monto/seg_actividad):')
  console.log('      node scripts/crear-listas-casino.js')
  console.log('  • Para sync incremental futuro desde Zeus:')
  console.log('      node scripts/sync-casino-players-live.js --auto')
  console.log('')

  await pool.end()
}

main().catch(err => {
  console.error('\n[rebuild] Fatal:', err.message)
  pool.end()
  process.exit(1)
})
