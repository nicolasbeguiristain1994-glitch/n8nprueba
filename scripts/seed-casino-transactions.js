#!/usr/bin/env node
/**
 * seed-casino-transactions.js
 *
 * Carga datos históricos de transacciones de casino desde archivos capturados
 * localmente hacia la tabla casino_transactions.
 *
 * Fuentes leídas:
 *   exports/api_caja_capturada.json        — captura legada (Playwright)
 *   exports/sesiones/sesion_*.json         — capturas incrementales
 *
 * No hace llamadas a la API de Zeus.
 *
 * La lógica de clasificación, normalización de fechas y deduplicación es
 * idéntica a sync-casino-players-live.js para garantizar paridad semántica.
 *
 * Uso:
 *   node scripts/seed-casino-transactions.js
 *   node scripts/seed-casino-transactions.js --dry-run
 *   node scripts/seed-casino-transactions.js --agentes=farabet,betcoin
 *
 * Variables de entorno requeridas:
 *   DATABASE_URL  — conexión a Postgres (se lee también del .env raíz)
 */

'use strict'

const { Pool }  = require('pg')
const fs        = require('fs')
const path      = require('path')

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

const EXPORTS_DIR  = path.resolve(__dirname, '..', 'exports')
const MAIN_FILE    = path.join(EXPORTS_DIR, 'api_caja_capturada.json')
const SESIONES_DIR = path.join(EXPORTS_DIR, 'sesiones')

const AGENTES_PERMITIDOS = new Set(['bigwin', 'ofizeus', 'betcoin', 'royal', 'farabet'])

const BATCH_SIZE = 500

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? 'true'] })
)

const DRY_RUN       = args['dry-run'] === 'true'
const AGENTES_ARG   = args.agentes
  ? new Set(args.agentes.split(',').map(a => a.trim()).filter(a => AGENTES_PERMITIDOS.has(a)))
  : AGENTES_PERMITIDOS

// ── Pool ──────────────────────────────────────────────────────────────────────

if (!process.env.DATABASE_URL) {
  console.error('[seed] ERROR: DATABASE_URL no está configurada.')
  console.error('[seed]   Definila en .env o exportala antes de correr el script.')
  process.exit(1)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  connectionTimeoutMillis: 30_000,
  idleTimeoutMillis: 600_000,
})

// ── Date helpers (idénticos a sync-casino-players-live.js) ───────────────────

/**
 * Convierte un timestamp UTC de Zeus a fecha local Argentina (UTC-3, sin DST).
 * Copia exacta de utcToArgDate() del sync script para garantizar paridad.
 */
function utcToArgDate(fechaStr) {
  if (!fechaStr) return null
  const d = new Date(fechaStr)
  if (isNaN(d.getTime())) return typeof fechaStr === 'string' ? fechaStr.substring(0, 10) : null
  return new Date(d.getTime() - 3 * 3_600_000).toISOString().substring(0, 10)
}

/**
 * Extrae el timestamp UTC completo de un string de fecha Zeus si contiene
 * componente horario. Zeus devuelve "2025-11-26T02:59:58.000Z" — strings así
 * se guardan directamente en fecha_hora_utc para filtrado sub-día.
 * Strings de solo fecha ("2025-11-26") devuelven null.
 */
function extractUtcTs(fechaStr) {
  if (!fechaStr) return null
  if (!fechaStr.includes('T') && !fechaStr.includes(' ')) return null
  const d = new Date(fechaStr)
  if (isNaN(d.getTime())) return null
  return d.toISOString()  // normalizado a UTC ISO
}

// ── Insert (idéntico a insertTransactions() del sync script) ──────────────────

/**
 * Inserta un lote de transacciones en casino_transactions usando los mismos
 * índices únicos y semántica ON CONFLICT DO NOTHING del sync script.
 * Retorna el número de filas realmente insertadas.
 */
async function insertTransactions(agente, txs, stats) {
  // withId:    [ [id_rec, fecha, fecha_hora_utc, agente, username, tipo, monto, raw_detalles] ]
  // withoutId: [ [fecha, fecha_hora_utc, agente, username, tipo, monto, raw_detalles] ]
  const withId    = []
  const withoutId = []

  for (const tx of txs) {
    const { id: id_rec = null, username, valor = 0, detalles = '', fecha } = tx
    if (!username || !fecha) { stats.skippedNoData++; continue }

    const dl = detalles.toLowerCase()

    // Excluir transferencias de capital entre agentes — idéntico al sync
    if (dl.includes('indirecto')) { stats.skippedIndirecto++; continue }

    const tipo = dl.includes('carga') ? 'carga' : dl.includes('retiro') ? 'retiro' : null
    if (!tipo) { stats.skippedNoTipo++; continue }

    const monto        = Math.round(Math.abs(parseFloat(valor) || 0))
    const fechaDate    = utcToArgDate(fecha)
    const fechaHoraUtc = extractUtcTs(fecha)   // full UTC timestamp; null for date-only strings
    if (!fechaDate) { stats.skippedNoData++; continue }

    if (id_rec) {
      withId.push([id_rec, fechaDate, fechaHoraUtc, agente, username, tipo, monto, detalles])
    } else {
      withoutId.push([fechaDate, fechaHoraUtc, agente, username, tipo, monto, detalles])
    }
    stats.parsed++
  }

  if (DRY_RUN) return 0

  let inserted = 0

  // ── Batch CON id_rec ──────────────────────────────────────────────────────
  // DO UPDATE backfills fecha_hora_utc for existing rows that were seeded
  // before migration 031 added this column.
  for (let i = 0; i < withId.length; i += BATCH_SIZE) {
    const chunk  = withId.slice(i, i + BATCH_SIZE)
    const values = chunk.map((_, idx) => {
      const b = idx * 8
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`
    }).join(',')
    const res = await pool.query(
      `INSERT INTO casino_transactions
         (id_rec, fecha, fecha_hora_utc, agente, username, tipo, monto, raw_detalles)
       VALUES ${values}
       ON CONFLICT (id_rec) WHERE id_rec IS NOT NULL DO UPDATE
         SET fecha_hora_utc = EXCLUDED.fecha_hora_utc
         WHERE casino_transactions.fecha_hora_utc IS NULL`,
      chunk.flat(),
    )
    inserted += res.rowCount ?? 0
  }

  // ── Batch SIN id_rec ─────────────────────────────────────────────────────
  for (let i = 0; i < withoutId.length; i += BATCH_SIZE) {
    const chunk  = withoutId.slice(i, i + BATCH_SIZE)
    const values = chunk.map((_, idx) => {
      const b = idx * 7
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7})`
    }).join(',')
    const res = await pool.query(
      `INSERT INTO casino_transactions
         (fecha, fecha_hora_utc, agente, username, tipo, monto, raw_detalles)
       VALUES ${values}
       ON CONFLICT (fecha, username, tipo, monto, agente) WHERE id_rec IS NULL DO UPDATE
         SET fecha_hora_utc = EXCLUDED.fecha_hora_utc
         WHERE casino_transactions.fecha_hora_utc IS NULL`,
      chunk.flat(),
    )
    inserted += res.rowCount ?? 0
  }

  return inserted
}

// ── Leer todas las fuentes capturadas ─────────────────────────────────────────

/**
 * Carga todos los objetos { [url]: [rows] } de todos los archivos fuente.
 * Deduplicación de URL: si una URL aparece en más de un archivo, prevalece
 * la primera aparición (mismos datos — capturar-api.js garantiza unicidad).
 */
function loadAllSources() {
  const merged = {}

  function mergeFile(filePath, label) {
    if (!fs.existsSync(filePath)) {
      console.warn(`[seed]   ⚠  No encontrado, saltando: ${label}`)
      return 0
    }
    let data
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch (e) {
      console.warn(`[seed]   ⚠  Error leyendo ${label}: ${e.message}`)
      return 0
    }
    let added = 0
    for (const [url, arr] of Object.entries(data)) {
      if (!url.includes('movimiento-fichas') || !Array.isArray(arr)) continue
      if (!merged[url]) { merged[url] = arr; added++ }
    }
    return added
  }

  const files = []

  // 1. Archivo legado
  const mainAdded = mergeFile(MAIN_FILE, 'api_caja_capturada.json')
  if (mainAdded > 0) files.push({ label: 'api_caja_capturada.json', urls: mainAdded })

  // 2. Archivos de sesiones
  if (fs.existsSync(SESIONES_DIR)) {
    const sesFiles = fs.readdirSync(SESIONES_DIR)
      .filter(f => f.startsWith('sesion_') && f.endsWith('.json'))
      .sort()
    for (const f of sesFiles) {
      const added = mergeFile(path.join(SESIONES_DIR, f), f)
      if (added > 0) files.push({ label: f, urls: added })
    }
  }

  return { merged, files }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  casino_transactions — seed desde archivos capturados')
  if (DRY_RUN) console.log('  *** DRY RUN — no se insertará nada ***')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(`  Agentes:   ${[...AGENTES_ARG].join(', ')}`)
  console.log('')

  // ── Leer fuentes ────────────────────────────────────────────────────────
  const { merged, files } = loadAllSources()

  console.log('  Archivos fuente cargados:')
  for (const { label, urls } of files) {
    console.log(`    ✓  ${label}  (${urls} URL${urls !== 1 ? 's' : ''} de movimiento-fichas)`)
  }

  // Agrupar URLs por agente
  const byAgente = {}
  for (const [url, rows] of Object.entries(merged)) {
    const m = url.match(/username=([^&]+)/)
    const agente = m ? decodeURIComponent(m[1]) : null
    if (!agente || !AGENTES_ARG.has(agente)) continue
    if (!byAgente[agente]) byAgente[agente] = []
    byAgente[agente].push(...rows)
  }

  const agentesSinDatos = [...AGENTES_ARG].filter(a => !byAgente[a])
  if (agentesSinDatos.length) {
    console.warn(`  ⚠  Sin datos capturados para: ${agentesSinDatos.join(', ')}`)
  }

  console.log('')

  // ── Estadísticas globales ────────────────────────────────────────────────
  const globalStats = {
    parsed: 0,
    inserted: 0,
    skippedIndirecto: 0,
    skippedNoTipo: 0,
    skippedNoData: 0,
  }

  // ── Procesar por agente ──────────────────────────────────────────────────
  for (const agente of [...AGENTES_ARG].sort()) {
    const txs = byAgente[agente]
    if (!txs || !txs.length) continue

    const stats = { parsed: 0, inserted: 0, skippedIndirecto: 0, skippedNoTipo: 0, skippedNoData: 0 }

    const nInserted = await insertTransactions(agente, txs, stats)
    stats.inserted = nInserted

    const skipped = stats.skippedIndirecto + stats.skippedNoTipo + stats.skippedNoData
    const dupes   = stats.parsed - nInserted  // rows parsed but already in DB

    console.log(
      `  ${agente.padEnd(10)}` +
      `  raw=${String(txs.length).padStart(7)}` +
      `  parseadas=${String(stats.parsed).padStart(7)}` +
      `  insertadas=${String(DRY_RUN ? '(dry)' : nInserted).padStart(7)}` +
      `  dupes/ya-existían=${String(dupes).padStart(7)}` +
      `  filtradas=${String(skipped).padStart(5)}` +
      (stats.skippedIndirecto ? ` (${stats.skippedIndirecto} indirecto)` : '')
    )

    globalStats.parsed           += stats.parsed
    globalStats.inserted         += nInserted
    globalStats.skippedIndirecto += stats.skippedIndirecto
    globalStats.skippedNoTipo    += stats.skippedNoTipo
    globalStats.skippedNoData    += stats.skippedNoData
  }

  const totalSkipped = globalStats.skippedIndirecto + globalStats.skippedNoTipo + globalStats.skippedNoData
  const totalDupes   = globalStats.parsed - globalStats.inserted

  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  RESUMEN')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(`  Filas parseadas:         ${globalStats.parsed.toLocaleString('es-AR')}`)
  if (!DRY_RUN) {
    console.log(`  Filas insertadas (nuevas): ${globalStats.inserted.toLocaleString('es-AR')}`)
    console.log(`  Ya existían en DB:         ${totalDupes.toLocaleString('es-AR')}`)
  }
  console.log(`  Filtradas (indirecto):   ${globalStats.skippedIndirecto.toLocaleString('es-AR')}`)
  console.log(`  Filtradas (sin tipo):    ${globalStats.skippedNoTipo.toLocaleString('es-AR')}`)
  console.log(`  Filtradas (datos vacíos): ${globalStats.skippedNoData.toLocaleString('es-AR')}`)
  console.log('')

  if (DRY_RUN) {
    console.log('  DRY RUN completado. Volvé a correr sin --dry-run para insertar.')
  } else {
    console.log('  ✓  Seed completado.')
    console.log('')
    console.log('  Verificá con:')
    console.log('    SELECT agente, COUNT(*) AS rows, MIN(fecha), MAX(fecha)')
    console.log('    FROM casino_transactions GROUP BY agente ORDER BY agente;')
  }
  console.log('')

  await pool.end()
}

main().catch(err => {
  console.error('\n[seed] Fatal:', err.message)
  pool.end()
  process.exit(1)
})
