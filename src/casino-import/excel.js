'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const XLSX = require('xlsx')

const normalize = value => String(value ?? '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const agents = new Set(['adminroyal', 'adminfara', 'adminbtc', 'adminzeus', 'admbigwin', 'adminbigwin', 'adminimperio', 'imperio', 'adminbet', 'surmar', 'peaky'])

function discover(inputs) {
  const files = new Set()
  function visit(p) {
    if (fs.statSync(p).isDirectory()) {
      for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) visit(path.join(p, entry.name))
      }
    } else if (/^(ganamos|argenbet|zeus|bet30)_.+_20\d{2}-\d{2}.*\.xlsx$/i.test(path.basename(p))) files.add(path.resolve(p))
  }
  inputs.forEach(visit)
  return [...files].sort()
}

function localDate(value) {
  if (typeof value === 'number') {
    const d = XLSX.SSF.parse_date_code(value)
    if (!d) throw new Error('Fecha Excel inválida')
    value = `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`
  }
  let s = String(value ?? '').trim()
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) s = s.split('/').reverse().join('-')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) throw new Error(`Fecha inválida: ${s}`)
  return s
}

function amount(value) {
  // The supported exports contain numeric cells or unambiguous decimal strings.
  if (typeof value !== 'number' && !/^\d+(\.\d{1,2})?$/.test(String(value))) throw new Error('Monto inválido o ambiguo')
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(Math.round(n * 100)) || Math.abs(n * 100 - Math.round(n * 100)) > 0.0001) throw new Error('Monto inválido o con más de dos decimales')
  return n.toFixed(2)
}

function recordId(id) {
  if (/^\d+$/.test(id) && BigInt(id) <= 9223372036854775807n) return BigInt(id).toString()
  // Compatibility with legacy numeric indexes; source_id is the authoritative ID.
  // A hash collision is checked explicitly against persisted source_id, never ignored.
  return (-BigInt('0x' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 15)) - 1n).toString()
}

function readFile(file) {
  const match = path.basename(file).match(/^(ganamos|argenbet|zeus|bet30)_(.+?)_(20\d{2}-\d{2})/i)
  if (!match) throw new Error(`Nombre de archivo sin plataforma/agente/período: ${file}`)
  const [, platformName, agentName, month] = match
  const platform = normalize(platformName), agente = normalize(agentName)
  const book = XLSX.readFile(file)
  const report = { file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), platform, agente, month, coverage: /SOLO-TOTALES/i.test(file) ? 'totals_only' : /DETALLE-PARCIAL/i.test(file) ? 'partial' : 'detail_available', rows: 0, excluded: 0, duplicates: 0 }
  if (!book.Sheets.Movimientos) return { report: { ...report, coverage: 'no_individual_transactions' }, transactions: [] }
  const rows = XLSX.utils.sheet_to_json(book.Sheets.Movimientos, { header: 1, defval: null })
  const header = rows.findIndex(r => ['id', 'fecha', 'jugador', 'tipo', 'monto'].every(k => r.map(normalize).includes(k)))
  if (header < 0) {
    if (/SIN-MOVIMIENTOS/i.test(file)) return { report, transactions: [] }
    throw new Error(`No se encuentra encabezado Movimientos: ${file}`)
  }
  const keys = rows[header].map(normalize), transactions = []
  for (let i = header + 1; i < rows.length; i++) {
    if (rows[i].every(v => v == null || v === '')) continue
    const r = Object.fromEntries(keys.map((k, j) => [k, rows[i][j]]))
    if (!r.jugador && !r.fecha && /^Sin movimientos devueltos por la API/.test(String(r.id))) continue
    try {
      const username = normalize(r.jugador)
      if (agents.has(username) || normalize(r.detalle).includes('indirecto')) { report.excluded++; continue }
      if (!username || username.length > 100 || !r.id || (typeof r.id === 'number' && !Number.isSafeInteger(r.id))) throw new Error('Jugador o ID inválido')
      const tipo = ({ deposito: 'carga', carga: 'carga', retiro: 'retiro' })[normalize(r.tipo)]
      if (!tipo) throw new Error('Tipo desconocido')
      const fecha = localDate(r.fecha)
      if (fecha.slice(0, 7) !== month) throw new Error('Fecha fuera del período del archivo')
      let hora = r.hora
      if (typeof hora === 'number') hora = XLSX.SSF.format('hh:mm:ss', hora)
      if (!/^\d{2}:\d{2}:\d{2}$/.test(String(hora)) || hora > '23:59:59' || Number(hora.slice(3, 5)) > 59 || Number(hora.slice(6)) > 59) throw new Error('Hora inválida')
      const source_id = String(r.id).trim()
      transactions.push({ platform, agente, username, tipo, monto: amount(r.monto), fecha,
        fecha_hora_utc: new Date(`${fecha}T${hora}-03:00`).toISOString(), source_id, id_rec: recordId(source_id),
        raw_detalles: String(r.detalle || r.nota || r.tipo), source_file: file, source_row: i + 1 })
      report.rows++
    } catch (e) { throw new Error(`${file}: fila ${i + 1}: ${e.message}`) }
  }
  return { report, transactions }
}

const signature = t => JSON.stringify([t.platform, t.agente, t.username, t.tipo, t.monto, t.fecha, t.fecha_hora_utc])
function readFiles(files) {
  const seen = new Map(), reports = []
  for (const file of files) {
    const { report, transactions } = readFile(file)
    for (const tx of transactions) {
      const key = `${tx.platform}:${tx.source_id}`
      if (seen.has(key)) {
        if (signature(tx) !== signature(seen.get(key))) throw new Error(`ID con datos contradictorios: ${key} (${file})`)
        report.duplicates++
      } else seen.set(key, tx)
    }
    reports.push(report)
  }
  return { reports, transactions: [...seen.values()] }
}

module.exports = { discover, readFile, readFiles, localDate, amount, recordId }
