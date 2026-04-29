#!/usr/bin/env node
/**
 * repair-fecha-utc.js
 *
 * Repara las filas de casino_transactions que tienen `fecha` incorrecta
 * (fecha UTC en lugar de fecha Argentina UTC-3).
 *
 * Mecanismo: para cada agente, obtiene transacciones de Zeus en el rango
 * que existe en la BD, calcula la fecha Argentina correcta de cada timestamp
 * UTC, y actualiza SOLO las filas donde la fecha difiere — usando id_rec
 * como clave exacta.
 *
 * Es 100% UPDATE (no INSERT ni DELETE). Idempotente: se puede correr más de
 * una vez sin problema.
 *
 * Uso:
 *   node scripts/repair-fecha-utc.js
 *   node scripts/repair-fecha-utc.js --dry-run        (muestra cambios, no escribe)
 *   node scripts/repair-fecha-utc.js --agente=betcoin  (solo un agente)
 *
 * Variables de entorno requeridas:
 *   DATABASE_URL, ZEUS_API_KEY, ZEUS_PLAYER_TOKEN
 */

const { Pool } = require('pg')

// ── Config ────────────────────────────────────────────────────────────────────

const API_BASE     = (process.env.ZEUS_API_BASE || 'https://local-admin2.zeuscasino.fun').trim()
const API_KEY      = (process.env.ZEUS_API_KEY  || '').trim()
const PLAYER_TOKEN = (process.env.ZEUS_PLAYER_TOKEN || '').trim()
const TIMEZONE     = '-03'

if (!API_KEY || !PLAYER_TOKEN) {
  console.error('[repair] ERROR: ZEUS_API_KEY y ZEUS_PLAYER_TOKEN son requeridos')
  process.exit(1)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  idleTimeoutMillis: 600_000,
})

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? 'true'] })
)

const DRY_RUN = args['dry-run'] === 'true'
// Soporta --agente=betcoin o --agentes=betcoin,bigwin,farabet
const AGENTE_FILTER = args.agentes
  ? args.agentes.split(',').map(a => a.trim()).filter(Boolean)
  : args.agente
    ? [args.agente.trim()]
    : null   // null = todos los agentes

if (DRY_RUN) console.log('[repair] MODO DRY-RUN: no se escribirá nada en la BD')

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d) {
  return `${d} 00:00:00`
}

function addOneDay(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().substring(0, 10)
}

function subOneDay(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().substring(0, 10)
}

/**
 * Convierte timestamp UTC de Zeus a fecha local Argentina (UTC-3, sin DST).
 * El error original era hacer substring(0,10) directo sobre el string UTC.
 */
function utcToArgDate(fechaStr) {
  if (!fechaStr) return null
  const d = new Date(fechaStr)
  if (isNaN(d.getTime())) return typeof fechaStr === 'string' ? fechaStr.substring(0, 10) : null
  return new Date(d.getTime() - 3 * 3_600_000).toISOString().substring(0, 10)
}

// ── API ───────────────────────────────────────────────────────────────────────

async function fetchTransactions(agente, desde, hasta) {
  const params = new URLSearchParams({
    username:  agente,
    startDate: fmtDate(desde),
    endDate:   fmtDate(addOneDay(hasta)),   // exclusivo
    timezone:  TIMEZONE,
  })
  const url = `${API_BASE}/api/records/movimiento-fichas?${params}`

  const res = await fetch(url, {
    headers: {
      'X-Api-Key':      API_KEY,
      'X-Player-Token': PLAYER_TOKEN,
      'Accept':         'application/json, text/plain, */*',
      'Origin':         'https://panel-skin5.zeuscasino.fun',
      'Referer':        'https://panel-skin5.zeuscasino.fun/',
    },
    signal: AbortSignal.timeout(90_000),
  })

  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  return Array.isArray(body) ? body : (body.data ?? body.records ?? body.result ?? [])
}

// ── DB: rango y agentes ───────────────────────────────────────────────────────

async function getAgenteRanges() {
  const { rows } = await pool.query(`
    SELECT
      agente,
      MIN(fecha)::text AS min_fecha,
      MAX(fecha)::text AS max_fecha,
      COUNT(*)::int    AS total_rows
    FROM casino_transactions
    WHERE id_rec IS NOT NULL
      AND ($1::text[] IS NULL OR agente = ANY($1::text[]))
    GROUP BY agente
    ORDER BY agente
  `, [AGENTE_FILTER])
  return rows
}

// ── Repair por agente ─────────────────────────────────────────────────────────

async function repairAgente(agente, minFecha, maxFecha) {
  // Ampliar 1 día en cada extremo para capturar transacciones cuyo timestamp
  // UTC cae en el día anterior o posterior al rango almacenado en la BD.
  const desde = subOneDay(minFecha)
  const hasta  = addOneDay(maxFecha)

  console.log(`[repair] ${agente}: consultando Zeus ${desde} → ${hasta} ...`)

  let txs
  try {
    txs = await fetchTransactions(agente, desde, hasta)
  } catch (err) {
    console.error(`[repair] ${agente}: ERROR al consultar Zeus — ${err.message}`)
    return { updated: 0, alreadyCorrect: 0, notFound: 0, errors: 0 }
  }

  console.log(`[repair] ${agente}: ${txs.length} transacciones recibidas de Zeus`)

  // Construir mapa id_rec → correctArgDate
  const correctDates = new Map()
  for (const tx of txs) {
    const { id: id_rec, fecha, detalles = '' } = tx
    if (!id_rec || !fecha) continue
    const dl   = detalles.toLowerCase()
    const tipo = dl.includes('carga') ? 'carga' : dl.includes('retiro') ? 'retiro' : null
    if (!tipo) continue
    const correctDate = utcToArgDate(fecha)
    if (correctDate) correctDates.set(String(id_rec), correctDate)
  }

  console.log(`[repair] ${agente}: ${correctDates.size} transacciones con id_rec válido`)

  // Obtener todas las filas del agente en la BD (solo las que tienen id_rec)
  const { rows: dbRows } = await pool.query(`
    SELECT id_rec, fecha::text AS fecha
    FROM casino_transactions
    WHERE agente = $1 AND id_rec IS NOT NULL
  `, [agente])

  let updated = 0
  let alreadyCorrect = 0
  let notFound = 0
  let errors = 0

  const client = await pool.connect()
  try {
    for (const row of dbRows) {
      const correctDate = correctDates.get(String(row.id_rec))

      if (!correctDate) {
        // Esta fila existe en la BD pero Zeus no la devolvió en el rango ampliado.
        // Puede ocurrir si la tx está muy al borde del rango — no tocar.
        notFound++
        continue
      }

      if (row.fecha === correctDate) {
        alreadyCorrect++
        continue
      }

      if (DRY_RUN) {
        console.log(`  [dry] id_rec=${row.id_rec}: ${row.fecha} → ${correctDate}`)
        updated++
        continue
      }

      try {
        const result = await client.query(`
          UPDATE casino_transactions
          SET fecha = $1
          WHERE id_rec = $2 AND fecha != $1
        `, [correctDate, row.id_rec])
        if (result.rowCount > 0) updated++
        else alreadyCorrect++
      } catch (err) {
        console.error(`  [repair] id_rec=${row.id_rec} ERROR: ${err.message}`)
        errors++
      }
    }
  } finally {
    client.release()
  }

  return { updated, alreadyCorrect, notFound, errors }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const agentRanges = await getAgenteRanges()

  if (!agentRanges.length) {
    console.log('[repair] No se encontraron agentes con id_rec en la BD.')
    await pool.end()
    return
  }

  console.log(`[repair] ${agentRanges.length} agente(s) a procesar:`)
  for (const r of agentRanges) {
    console.log(`  ${r.agente}: ${r.total_rows} filas, rango ${r.min_fecha} → ${r.max_fecha}`)
  }
  console.log()

  let totalUpdated = 0
  let totalCorrect = 0
  let totalNotFound = 0
  let totalErrors = 0

  for (const { agente, min_fecha, max_fecha } of agentRanges) {
    const { updated, alreadyCorrect, notFound, errors } = await repairAgente(agente, min_fecha, max_fecha)
    totalUpdated  += updated
    totalCorrect  += alreadyCorrect
    totalNotFound += notFound
    totalErrors   += errors

    const tag = DRY_RUN ? '[dry]' : '[repair]'
    console.log(`${tag} ${agente}: ${updated} actualizadas, ${alreadyCorrect} ya correctas, ${notFound} no encontradas en Zeus, ${errors} errores`)
    console.log()

    // Pausa entre agentes para no saturar la API
    await new Promise(r => setTimeout(r, 600))
  }

  console.log('═══════════════════════════════════════════════════')
  console.log(`[repair] TOTAL: ${totalUpdated} filas ${DRY_RUN ? 'a actualizar' : 'actualizadas'}, ${totalCorrect} ya correctas, ${totalNotFound} no encontradas, ${totalErrors} errores`)
  console.log('═══════════════════════════════════════════════════')

  await pool.end()
}

main().catch(err => {
  console.error('[repair] Fatal:', err)
  pool.end()
  process.exit(1)
})
