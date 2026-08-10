#!/usr/bin/env node
'use strict'

/**
 * Casino players sync — orchestrator script.
 *
 * Reads agents from the DB (or --agentes override), runs the full sync pipeline
 * for each one via the platform connector, and persists results to:
 *   casino_players      (aggregated per-player stats)
 *   casino_transactions (raw transaction rows)
 *
 * Usage:
 *   node scripts/sync-casino-players-live.js
 *   node scripts/sync-casino-players-live.js --platform=zeus
 *   node scripts/sync-casino-players-live.js --desde=2024-01-01 --hasta=2026-05-12
 *   node scripts/sync-casino-players-live.js --auto
 *   node scripts/sync-casino-players-live.js --agentes=betcoin,royal,ofizeus
 *   node scripts/sync-casino-players-live.js --platform=bet30 --desde=2025-01-01 --hasta=2026-05-14 --chunk-days=30
 *   node scripts/sync-casino-players-live.js --platform=bet30 --concurrency=3
 *
 * Chunking automático (--chunk-days, default: 30):
 *   Si el rango de fechas supera chunk-days, el script lo divide en bloques y los
 *   procesa secuencialmente. Útil para la carga inicial de una plataforma nueva
 *   (rangos históricos largos) sin intervención manual ni riesgo de timeout.
 *   Si el rango cabe en un solo chunk, el comportamiento es idéntico al anterior.
 *
 * Concurrencia controlada (--concurrency, default: 1):
 *   Cuántos agentes se procesan en paralelo dentro de cada chunk.
 *   Con concurrency=1 (default) el comportamiento es idéntico al original.
 *   Con concurrency>1 se procesan varios agentes simultáneamente, controlado por
 *   p-limit para no saturar la API del casino ni la base de datos.
 *   Recomendado: no superar 3 para Zeus/Bet30.
 *
 * Required env vars (per platform — see src/config/platforms.config.json):
 *   DATABASE_URL
 *   ZEUS_API_KEY
 *   ZEUS_PLAYER_TOKEN
 *   ZEUS_API_BASE  (optional — overrides config baseUrl)
 */

const { Pool }                               = require('pg')
const { createConnector, getDefaultPlatform } = require('../src/casino-connectors/index')
const { createLogger }                        = require('../src/lib/logger')
const pLimit                                  = require('p-limit')

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? 'true'] })
)

const PLATFORM       = args.platform || getDefaultPlatform()
const AUTO           = args.auto === 'true'
const DESDE_ARG      = args.desde || '2020-01-01'
const HASTA_ARG      = args.hasta || new Date().toISOString().split('T')[0]
const AGENTES_FILTER = args.agentes
  ? args.agentes.split(',').map(a => a.trim()).filter(Boolean)
  : null  // null = all agents from DB
const CHUNK_DAYS    = Math.max(1, parseInt(args['chunk-days']  ?? '30', 10) || 30)
const CONCURRENCY   = Math.max(1, parseInt(args.concurrency    ?? '1',  10) || 1)

// ── DB pool ───────────────────────────────────────────────────────────────────

if (!process.env.DATABASE_URL) {
  // Logger not yet available — plain stderr before process.exit
  process.stderr.write('{"level":50,"msg":"DATABASE_URL is required","component":"sync"}\n')
  process.exit(1)
}

const log = createLogger({ component: 'sync', platform: PLATFORM })

const pool = new Pool({
  connectionString:             process.env.DATABASE_URL,
  keepAlive:                    true,
  keepAliveInitialDelayMillis:  10_000,
  connectionTimeoutMillis:      30_000,
  idleTimeoutMillis:            600_000,  // longer than the slowest Zeus API call
})

// Sin este listener, un corte de red en una conexión ociosa emite un 'error' sin
// manejar en el pool y Node mata el proceso en el acto. Es lo que venía pasando en
// las corridas largas: caían con EADDRNOTAVAIL a mitad del histórico, dejando la
// sincronización incompleta. Con el handler, la query en curso falla, ese agente
// se reporta como fallido y el resto del run continúa.
pool.on('error', err => {
  log.error({ err: err.message, code: err.code }, 'Idle DB connection error — el run continúa')
})

// ── DB queries (orchestration-level, not platform-specific) ───────────────────

async function resolveDesde(pool) {
  if (!AUTO) return DESDE_ARG
  const { rows } = await pool.query(
    `SELECT (MAX(fecha) + INTERVAL '1 day')::date::text AS desde FROM casino_transactions`
  )
  const desde = rows[0]?.desde ?? '2020-01-01'
  log.info({ desde }, 'Auto mode: resolved start date from DB')
  return desde
}

async function getAgentes(pool) {
  // --agentes es un override explícito: se usa tal cual, sin intersectarlo con
  // casino_players. Antes se filtraba contra la tabla y el bootstrap solo se
  // activaba si la intersección quedaba vacía, así que pedir un agente que aún
  // no existía en la DB junto a uno que sí existía descartaba al nuevo en
  // silencio — y no había forma de dar de alta un agente nuevo salvo con la
  // tabla completamente vacía.
  if (AGENTES_FILTER !== null) {
    log.info({ agents: AGENTES_FILTER }, 'Using --agentes override')
    return AGENTES_FILTER
  }

  const { rows } = await pool.query(
    `SELECT DISTINCT agente FROM casino_players
     WHERE agente IS NOT NULL
     ORDER BY agente`,
  )
  return rows.map(r => r.agente)
}

// ── Date chunking ─────────────────────────────────────────────────────────────

/**
 * Splits [desde, hasta] into consecutive chunks of at most `chunkDays` days.
 * The last chunk may be shorter if the range is not an exact multiple.
 * Returns a single-element array when the whole range fits in one chunk.
 *
 * @param {string} desde     YYYY-MM-DD inclusive start
 * @param {string} hasta     YYYY-MM-DD inclusive end
 * @param {number} chunkDays Maximum days per chunk (≥ 1)
 * @returns {{ desde: string, hasta: string }[]}
 */
function buildDateChunks(desde, hasta, chunkDays) {
  const chunks = []
  let cursor = new Date(desde + 'T00:00:00Z')
  const end  = new Date(hasta + 'T00:00:00Z')

  while (cursor <= end) {
    const chunkStart = cursor.toISOString().slice(0, 10)

    const tentativeEnd = new Date(cursor)
    tentativeEnd.setUTCDate(tentativeEnd.getUTCDate() + chunkDays - 1)
    const chunkEnd = tentativeEnd <= end ? tentativeEnd : end

    chunks.push({ desde: chunkStart, hasta: chunkEnd.toISOString().slice(0, 10) })

    cursor = new Date(chunkEnd)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return chunks
}

// ── Agent runner ──────────────────────────────────────────────────────────────

/**
 * Runs the full sync pipeline for one agent and one date range.
 * Errors are caught and logged here so a failing agent never aborts the batch.
 * The 400ms politeness delay is always applied (even on error) to protect the
 * platform API regardless of concurrency mode.
 *
 * @param {object} connector
 * @param {string} agente
 * @param {string} desde      YYYY-MM-DD
 * @param {string} hasta      YYYY-MM-DD
 * @param {object} logCtx     Extra fields merged into every log call (e.g. chunk index)
 * @returns {Promise<{ players: number, tx: number }>}
 */
async function runAgent(connector, agente, desde, hasta, logCtx = {}) {
  try {
    const { txCount, playerCount, insertedTxCount } =
      await connector.syncAgent(agente, desde, hasta)

    log.info({ agent: agente, txCount, playerCount, insertedTxCount, ...logCtx }, 'Agent synced')
    return { players: playerCount, tx: insertedTxCount }
  } catch (err) {
    log.error({ agent: agente, err: err.message, ...logCtx }, 'Agent sync failed')
    return { players: 0, tx: 0 }
  } finally {
    // Politeness delay — protects the platform API from bursts.
    // Runs for each agent regardless of concurrency so that even at max
    // concurrency=N, each slot waits 400ms before accepting the next task.
    await new Promise(r => setTimeout(r, 400))
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const connector = createConnector(PLATFORM, pool)

  await connector.authenticate()

  const desde = await resolveDesde(pool)
  const hasta = HASTA_ARG

  if (AUTO && desde > hasta) {
    log.info({ hasta }, 'Already synced — nothing to do')
    await pool.end()
    return
  }

  const agentes = await getAgentes(pool)
  if (!agentes.length) {
    log.warn('No agents found — use --agentes=name1,name2 to bootstrap')
    await pool.end()
    return
  }
  log.info({ count: agentes.length, agents: agentes }, 'Agents loaded')

  const chunks      = buildDateChunks(desde, hasta, CHUNK_DAYS)
  const totalChunks = chunks.length
  const isChunked   = totalChunks > 1
  const isParallel  = CONCURRENCY > 1

  log.info({
    platform:    PLATFORM,
    from:        desde,
    to:          hasta,
    agents:      agentes.length,
    chunks:      totalChunks,
    chunkDays:   CHUNK_DAYS,
    concurrency: CONCURRENCY,
  }, [
    isChunked   ? `${totalChunks} chunks × ${CHUNK_DAYS} days` : null,
    isParallel  ? `concurrency: ${CONCURRENCY}` : null,
  ].filter(Boolean).join(', ') || 'Starting sync run')

  // One p-limit instance shared across all chunks.
  // Because chunks are processed sequentially (await per chunk), the limit
  // effectively resets between chunks — all slots are free when the next
  // chunk starts. The instance is reused to avoid unnecessary allocations.
  const limit = pLimit(CONCURRENCY)

  let grandTotalPlayers = 0
  let grandTotalTx      = 0

  for (let ci = 0; ci < chunks.length; ci++) {
    const { desde: chunkDesde, hasta: chunkHasta } = chunks[ci]
    const logCtx = isChunked ? { chunk: ci + 1 } : {}

    if (isChunked) {
      log.info(
        { chunk: ci + 1, total: totalChunks, from: chunkDesde, to: chunkHasta },
        `Procesando chunk ${ci + 1}/${totalChunks}: ${chunkDesde} → ${chunkHasta}`,
      )
    }

    let chunkPlayers = 0
    let chunkTx      = 0

    if (!isParallel) {
      // ── Sequential (concurrency=1) — identical to original behavior ──────────
      for (const agente of agentes) {
        const { players, tx } = await runAgent(connector, agente, chunkDesde, chunkHasta, logCtx)
        chunkPlayers += players
        chunkTx      += tx
      }
    } else {
      // ── Parallel — p-limit caps simultaneous agent calls at CONCURRENCY ──────
      //
      // activeCount tracks how many agents are running right now. It is safe
      // to mutate from multiple tasks because JS is single-threaded: the ++
      // and -- always complete synchronously before the next await yields.
      let activeCount = 0

      const results = await Promise.all(
        agentes.map(agente =>
          limit(async () => {
            activeCount++
            log.info(
              { agent: agente, active: activeCount, maxConcurrent: CONCURRENCY, ...logCtx },
              `Starting agent: ${agente} (${activeCount}/${CONCURRENCY} active)`,
            )
            const result = await runAgent(connector, agente, chunkDesde, chunkHasta, logCtx)
            activeCount--
            return result
          })
        )
      )

      for (const { players, tx } of results) {
        chunkPlayers += players
        chunkTx      += tx
      }
    }

    grandTotalPlayers += chunkPlayers
    grandTotalTx      += chunkTx

    if (isChunked) {
      log.info(
        {
          chunk:      ci + 1,
          total:      totalChunks,
          from:       chunkDesde,
          to:         chunkHasta,
          players:    chunkPlayers,
          txInserted: chunkTx,
          remaining:  totalChunks - (ci + 1),
        },
        `Chunk ${ci + 1}/${totalChunks} completado`,
      )
    }
  }

  log.info(
    {
      totalPlayers:    grandTotalPlayers,
      totalTxInserted: grandTotalTx,
      chunks:          totalChunks,
    },
    'Sync run complete',
  )

  await pool.end()
}

main().catch(err => {
  log.error({ err: err.message, stack: err.stack }, 'Fatal error')
  pool.end()
  process.exit(1)
})
