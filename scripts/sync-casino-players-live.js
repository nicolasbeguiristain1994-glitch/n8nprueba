#!/usr/bin/env node
/**
 * sync-casino-players-live.js
 *
 * Sincroniza casino_players con datos en vivo de la API de zeuscasino.
 * Por cada agente en la BD, consulta todas sus transacciones, agrega
 * cargas/retiros por jugador y hace upsert en casino_players.
 *
 * Uso:
 *   node scripts/sync-casino-players-live.js
 *   node scripts/sync-casino-players-live.js --desde=2024-01-01 --hasta=2026-04-28
 *
 * Variables de entorno requeridas:
 *   DATABASE_URL        — conexión a Postgres
 *   ZEUS_API_KEY        — X-Api-Key del panel de zeus
 *   ZEUS_PLAYER_TOKEN   — X-Player-Token del panel de zeus
 *   ZEUS_API_BASE       — (opcional) base URL, default: https://local-admin2.zeuscasino.fun
 */

const { Pool } = require('pg')

// ── Config ────────────────────────────────────────────────────────────────────

const API_BASE     = (process.env.ZEUS_API_BASE || 'https://local-admin2.zeuscasino.fun').trim()
const API_KEY      = (process.env.ZEUS_API_KEY  || '').trim()
const PLAYER_TOKEN = (process.env.ZEUS_PLAYER_TOKEN || '').trim()
const TIMEZONE     = '-03'

if (!API_KEY || !PLAYER_TOKEN) {
  console.error('[sync] ERROR: ZEUS_API_KEY y ZEUS_PLAYER_TOKEN son requeridos')
  process.exit(1)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  connectionTimeoutMillis: 30_000,
  idleTimeoutMillis: 600_000,   // 10 min — mayor que la llamada más larga a Zeus
})

// ── CLI args: --desde=YYYY-MM-DD --hasta=YYYY-MM-DD --auto ───────────────────

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? 'true'] })
)
const AUTO  = args.auto === 'true'
const DESDE = args.desde || '2020-01-01'
const HASTA = args.hasta || new Date().toISOString().split('T')[0]
// --agentes=betcoin,royal,ofizeus  → filtra qué agentes sincronizar
const AGENTES_FILTER = args.agentes
  ? args.agentes.split(',').map(a => a.trim()).filter(Boolean)
  : null   // null = todos

async function resolveDesde() {
  if (!AUTO) return DESDE
  const { rows } = await pool.query(
    `SELECT (MAX(fecha) + INTERVAL '1 day')::date::text AS desde FROM casino_transactions`
  )
  const desde = rows[0]?.desde ?? '2020-01-01'
  console.log(`[sync] --auto: última fecha en BD → desde ${desde}`)
  return desde
}

// ── API ───────────────────────────────────────────────────────────────────────

function fmtDate(d) {
  return `${d} 00:00:00`  // espacio — URLSearchParams lo codifica como + que es lo que la API espera
}

/**
 * Suma un día a una fecha YYYY-MM-DD.
 * Zeus usa endDate EXCLUSIVO (igual que el panel: rango abril → endDate=May1).
 * Usar noon UTC para evitar problemas de horario de verano.
 */
function addOneDay(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().substring(0, 10)
}

/**
 * Convierte un timestamp UTC de Zeus a fecha local Argentina (UTC-3, sin DST).
 * Zeus devuelve timestamps UTC (Z). Una transacción de las 22:00 ARG es
 * 01:00 UTC del día siguiente — substring(0,10) daría la fecha incorrecta.
 */
function utcToArgDate(fechaStr) {
  if (!fechaStr) return null
  const d = new Date(fechaStr)
  if (isNaN(d.getTime())) return typeof fechaStr === 'string' ? fechaStr.substring(0, 10) : null
  // Argentina = UTC−3, sin horario de verano (IANA: America/Argentina/Buenos_Aires)
  return new Date(d.getTime() - 3 * 3_600_000).toISOString().substring(0, 10)
}

async function fetchTransactions(agente, desde, hasta) {
  const params = new URLSearchParams({
    username:  agente,
    startDate: fmtDate(desde),
    endDate:   fmtDate(addOneDay(hasta)),  // exclusivo: día siguiente a hasta (igual que el panel Zeus)
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
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const body = await res.json()
  // Soporta respuesta como array directo o como { data: [...] }
  return Array.isArray(body) ? body : (body.data ?? body.records ?? body.result ?? [])
}

// ── Agregación ────────────────────────────────────────────────────────────────

function aggregate(txs) {
  const map = new Map()

  for (const tx of txs) {
    const { username, creator_username, valor = 0, detalles = '', fecha } = tx
    if (!username || !creator_username) continue

    if (!map.has(username)) {
      map.set(username, {
        username,
        agente:        creator_username,
        total_cargas:  0,
        total_retiros: 0,
        cant_cargas:   0,
        cant_retiros:  0,
        fecha_primera: null,
        fecha_ultima:  null,
      })
    }

    const p  = map.get(username)
    const dl = detalles.toLowerCase()

    if (dl.includes('carga')) {
      p.total_cargas += Math.round(Math.abs(valor))
      p.cant_cargas++
    } else if (dl.includes('retiro')) {
      p.total_retiros += Math.round(Math.abs(valor))
      p.cant_retiros++
    }

    if (fecha) {
      if (!p.fecha_primera || fecha < p.fecha_primera) p.fecha_primera = fecha
      if (!p.fecha_ultima  || fecha > p.fecha_ultima)  p.fecha_ultima  = fecha
    }
  }

  return [...map.values()]
}

// ── Insertar transacciones individuales ───────────────────────────────────────

async function insertTransactions(agente, txs) {
  if (!txs.length) return 0

  const client = await pool.connect()
  let inserted = 0

  try {
    for (const tx of txs) {
      const {
        id:             id_rec   = null,   // IDREC de Zeus (puede no existir)
        username,
        creator_username,
        valor          = 0,
        detalles       = '',
        fecha,
      } = tx

      if (!username || !fecha) continue

      const dl   = detalles.toLowerCase()
      const tipo = dl.includes('carga') ? 'carga' : dl.includes('retiro') ? 'retiro' : null
      if (!tipo) continue

      const monto       = Math.round(Math.abs(valor))
      const fechaDate   = utcToArgDate(fecha)   // convierte UTC → fecha en hora Argentina
      if (!fechaDate) continue

      // Siempre usar el agente que se está consultando en Zeus, no creator_username.
      // Para transacciones de jugadores: creator_username == agente (mismo valor).
      // Para "Carga indirecto" (capital de adminbet → betcoin): creator_username='adminbet'
      // pero el agente dueño del movimiento ES betcoin — se perdería bajo adminbet si no.
      const agenteNombre = agente

      try {
        if (id_rec) {
          // Tiene ID de Zeus — upsert por id_rec
          await client.query(`
            INSERT INTO casino_transactions (id_rec, fecha, agente, username, tipo, monto, raw_detalles)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (id_rec) WHERE id_rec IS NOT NULL DO NOTHING
          `, [id_rec, fechaDate, agenteNombre, username, tipo, monto, detalles])
        } else {
          // Sin ID — upsert por (fecha, username, tipo, monto, agente)
          await client.query(`
            INSERT INTO casino_transactions (fecha, agente, username, tipo, monto, raw_detalles)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (fecha, username, tipo, monto, agente) WHERE id_rec IS NULL DO NOTHING
          `, [fechaDate, agenteNombre, username, tipo, monto, detalles])
        }
        inserted++
      } catch (_) {
        // Conflicto de unicidad — registro ya existe, ignorar
      }
    }
  } finally {
    client.release()
  }

  return inserted
}

// ── Upsert ────────────────────────────────────────────────────────────────────

async function upsert(players) {
  if (!players.length) return 0
  const client = await pool.connect()
  try {
    for (const p of players) {
      await client.query(`
        INSERT INTO casino_players
          (username, agente, total_cargas, total_retiros, cant_cargas, cant_retiros, fecha_primera, fecha_ultima)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (username_lower) DO UPDATE SET
          agente        = EXCLUDED.agente,
          total_cargas  = EXCLUDED.total_cargas,
          total_retiros = EXCLUDED.total_retiros,
          cant_cargas   = EXCLUDED.cant_cargas,
          cant_retiros  = EXCLUDED.cant_retiros,
          fecha_primera = LEAST(casino_players.fecha_primera,  EXCLUDED.fecha_primera),
          fecha_ultima  = GREATEST(casino_players.fecha_ultima, EXCLUDED.fecha_ultima)
      `, [
        p.username, p.agente,
        p.total_cargas, p.total_retiros,
        p.cant_cargas,  p.cant_retiros,
        p.fecha_primera, p.fecha_ultima,
      ])
    }
    return players.length
  } finally {
    client.release()
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function getAgentes() {
  const { rows } = await pool.query(
    `SELECT DISTINCT agente FROM casino_players
     WHERE agente IS NOT NULL
       AND ($1::text[] IS NULL OR agente = ANY($1::text[]))
     ORDER BY agente`,
    [AGENTES_FILTER]
  )
  return rows.map(r => r.agente)
}

async function main() {
  const desde = await resolveDesde()
  const hasta = HASTA

  if (AUTO && desde > hasta) {
    console.log(`[sync] Ya sincronizado hasta ${hasta}, nada que hacer.`)
    await pool.end()
    return
  }

  console.log(`[sync] Iniciando: ${desde} → ${hasta}`)

  const agentes = await getAgentes()
  console.log(`[sync] ${agentes.length} agentes: ${agentes.join(', ')}`)

  let total = 0

  for (const agente of agentes) {
    try {
      const txs      = await fetchTransactions(agente, desde, hasta)
      const players  = aggregate(txs)
      const nPlayers = await upsert(players)
      const nTxs     = await insertTransactions(agente, txs)
      total += nPlayers
      console.log(`[sync] ${agente}: ${txs.length} transacciones → ${players.length} jugadores, ${nTxs} tx nuevas ✓`)
    } catch (err) {
      console.error(`[sync] ${agente}: ERROR — ${err.message}`)
    }
    // Pausa breve para no saturar la API
    await new Promise(r => setTimeout(r, 400))
  }

  console.log(`[sync] Completado — ${total} jugadores actualizados en total`)
  await pool.end()
}

main().catch(err => {
  console.error('[sync] Fatal:', err)
  pool.end()
  process.exit(1)
})
