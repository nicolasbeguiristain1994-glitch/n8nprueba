'use strict'

// Offline normalization boundary. No pool, fetch, credentials or persistence.
const MAX_BODY_BYTES = 32 * 1024 * 1024
const MAX_SOURCE_ROWS = 5000
const MAX_CENTS = 99999999999999999999n // NUMERIC(20,2)
const BONUS = /(?:^|[^\p{L}\p{M}\p{N}_])bonos?(?=$|[^\p{L}\p{M}\p{N}_])/iu
class NormalizationError extends Error {
  constructor(reason) { super(reason); this.name = 'NormalizationError'; this.code = 'INVALID_RESPONSE'; this.reason = reason }
}
const fail = reason => { throw new NormalizationError(reason) }

function sourceId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) fail('SOURCE_ID_INVALID')
  return value
}

function exactCents(value, { allowNegative = true } = {}) {
  if (typeof value !== 'string' || value.length > 100) fail('AMOUNT_NOT_EXACT')
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,2}))?$/.exec(value)
  if (!match || (!allowNegative && match[1] === '-')) fail('AMOUNT_NOT_EXACT')
  const exponent = Number(match[4] || 0)
  if (Math.abs(exponent) > 30) fail('AMOUNT_NOT_EXACT')
  let integer = BigInt(match[2] + (match[3] || '')), scale = (match[3] || '').length - exponent
  if (scale > 2) {
    const divisor = 10n ** BigInt(scale - 2)
    if (integer % divisor) fail('AMOUNT_SUBCENT_PRECISION')
    integer /= divisor
  } else integer *= 10n ** BigInt(2 - scale)
  if (integer > MAX_CENTS) fail('AMOUNT_OUT_OF_RANGE')
  return integer // Stored source values are absolute, as in the legacy contract.
}
function formatCents(value) { return `${value / 100n}.${String(value % 100n).padStart(2, '0')}` }

function timestamp(value, allowNaiveUtc = false) {
  if (typeof value !== 'string') fail('TIMESTAMP_INVALID')
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(value)
  if (!match || (!match[8] && !allowNaiveUtc)) fail('TIMESTAMP_INVALID')
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const base = Date.UTC(year, month - 1, day, hour, minute, second), check = new Date(base)
  if (year < 1970 || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
      check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) fail('TIMESTAMP_INVALID')
  let offset = 0
  if (match[8] && match[8] !== 'Z') {
    const digits = match[8].slice(1).replace(':', ''), hours = Number(digits.slice(0, 2)), minutes = Number(digits.slice(2) || 0)
    if (hours > 23 || minutes > 59) fail('TIMESTAMP_INVALID')
    offset = (hours * 60 + minutes) * (match[8][0] === '+' ? 1 : -1)
  }
  const fraction = (match[7] || '').padEnd(6, '0'), micros = BigInt(base - offset * 60000) * 1000n + BigInt(fraction)
  return { micros: micros.toString(), day: new Date(Number(micros / 1000n) - 10800000).toISOString().slice(0, 10),
    utc: new Date(Number(micros / 1000n)).toISOString().replace(/\.\d{3}Z$/, `.${fraction}Z`) }
}

// Node 20 JSON.parse lacks the numeric source lexeme. Scan the already validated
// JSON text BEFORE parsing id/valor into JS numbers; no Number-to-string recovery.
function parseExactJson(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BODY_BYTES) fail('SOURCE_BODY_LIMIT')
  try { JSON.parse(text) } catch { fail('SOURCE_JSON_INVALID') }
  let out = '', index = 0, lastString = null, field = null
  while (index < text.length) {
    const char = text[index]
    if (char === '"') {
      const start = index++
      while (index < text.length) { if (text[index] === '\\') { index += 2; continue } if (text[index++] === '"') break }
      const token = text.slice(start, index); out += token; lastString = JSON.parse(token); field = null; continue
    }
    if (char === ':') { field = lastString; out += char; index++; continue }
    if (/\s/.test(char)) { out += char; index++; continue }
    if (char === '-' || /[0-9]/.test(char)) {
      const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index))[0]
      out += ['id', 'valor'].includes(field) ? JSON.stringify(token) : token
      index += token.length; field = null; continue
    }
    out += char; index++; field = null; lastString = null
  }
  return JSON.parse(out)
}

function nonempty(value, reason) {
  if (typeof value !== 'string' || !value.trim() || value.length > 250) fail(reason)
  return value.trim()
}
function validateScope({ platform, agent, day }) {
  if (!['zeus', 'bet30'].includes(platform)) fail('PLATFORM_INVALID')
  nonempty(agent, 'AGENT_INVALID')
  if (agent !== agent.trim()) fail('AGENT_INVALID')
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || timestamp(`${day}T03:00:00Z`).day !== day) fail('DAY_INVALID')
}
function normalizeRaw(raw, { platform, agent, day }) {
  validateScope({ platform, agent, day })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('SOURCE_ROW_INVALID')
  const id = sourceId(raw.id), username = nonempty(raw.username, 'SOURCE_USERNAME_INVALID')
  if (typeof raw.detalles !== 'string') fail('SOURCE_DETAILS_INVALID')
  // Validate identity before intentionally excluding inter-agent capital transfers.
  // Excluded IDs still participate in duplicate detection in normalizeWithStats.
  if (raw.detalles.toLowerCase().includes('indirecto')) return { excluded: true, id }
  const creator = nonempty(raw.creator_username, 'SOURCE_CREATOR_INVALID')
  const details = raw.detalles.toLowerCase(), carga = details.includes('carga'), retiro = details.includes('retiro')
  if (carga && retiro) fail('SOURCE_TYPE_AMBIGUOUS')
  const tipo = carga ? 'carga' : retiro ? 'retiro' : platform === 'zeus' && BONUS.test(raw.detalles) ? 'carga' : null
  // Bet30 bonus-only rows are UNDEFINED FOR INGESTION, even if an attribution
  // preview excluded them after a global database lookup. Never copy that rule.
  if (!tipo) fail('SOURCE_TYPE_INVALID')
  const when = timestamp(raw.fecha, true)
  if (when.day !== day) fail('SOURCE_OUTSIDE_DAY')
  return { id, creatorMismatch: creator !== agent, row: {
    id_rec: id, username, agente: agent, tipo, monto: formatCents(exactCents(raw.valor)),
    fecha: when.day, fecha_hora_utc: when.utc, raw_detalles: raw.detalles,
  } }
}

function createExactNormalizationAdapter(platform) {
  if (!['zeus', 'bet30'].includes(platform)) fail('PLATFORM_INVALID')
  return Object.freeze({
    parseExactJson,
    normalizeWithStats(rawRows, { agent, day }) {
      validateScope({ platform, agent, day })
      if (!Array.isArray(rawRows) || rawRows.length >= MAX_SOURCE_ROWS) fail('SOURCE_ROW_LIMIT')
      const rows = [], seen = new Set()
      let excluded = 0, creatorMismatchCount = 0
      for (const raw of rawRows) {
        const result = normalizeRaw(raw, { platform, agent, day })
        if (seen.has(result.id)) fail('SOURCE_ID_DUPLICATE')
        seen.add(result.id)
        if (result.excluded) excluded++
        else { rows.push(result.row); if (result.creatorMismatch) creatorMismatchCount++ }
      }
      return { rows, invalid: 0, excluded, creatorMismatchCount }
    },
  })
}

// Pure comparison only. The eventual writer must select/lock all matching rows,
// prove uniqueness and call this BEFORE ON CONFLICT; frozen Base does not do so.
// No tolerated legacy rounding, timestamp fill, source_id change or amount update.
function assertExactReplay(existing, incoming, platform) {
  if (!existing || !incoming || !['zeus', 'bet30'].includes(platform)) fail('REPLAY_INVALID')
  if (existing.platform !== platform || existing.source_id !== null || Object.hasOwn(incoming, 'source_id') ||
      sourceId(existing.id_rec) !== sourceId(incoming.id_rec) ||
      existing.agente !== incoming.agente ||
      typeof existing.username !== 'string' || existing.username !== existing.username.trim() ||
      nonempty(existing.username, 'REPLAY_INVALID').toLowerCase() !== nonempty(incoming.username, 'REPLAY_INVALID').toLowerCase() ||
      existing.tipo !== incoming.tipo || existing.fecha !== incoming.fecha) fail('REPLAY_IDENTITY_MISMATCH')
  const a = timestamp(existing.fecha_hora_utc), b = timestamp(incoming.fecha_hora_utc)
  if (a.micros !== b.micros || a.day !== existing.fecha || b.day !== incoming.fecha) fail('REPLAY_TIMESTAMP_MISMATCH')
  if (exactCents(existing.monto, { allowNegative: false }) !== exactCents(incoming.monto, { allowNegative: false })) fail('REPLAY_AMOUNT_MISMATCH')
  return true
}

module.exports = { NormalizationError, sourceId, exactCents, formatCents, timestamp, parseExactJson,
  normalizeRaw, createExactNormalizationAdapter, assertExactReplay }
