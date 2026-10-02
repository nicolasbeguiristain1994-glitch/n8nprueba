'use strict'

const { parseExactJson, sourceId, timestamp, NormalizationError } = require('./exact.cjs')
const MAX_BYTES = 32 * 1024 * 1024
const MAX_ROWS = 5000
const fail = reason => { throw new NormalizationError(reason) }
function windowsForDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) fail('DAY_INVALID')
  const start = timestamp(`${day}T03:00:00Z`)
  if (start.day !== day) fail('DAY_INVALID')
  const next = new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)
  return [
    { name: 'full', start: `${day} 00:00:00`, end: `${next} 00:00:00`, low: `${day}T03:00:00Z`, high: `${next}T03:00:00Z` },
    { name: 'firstHalf', start: `${day} 00:00:00`, end: `${day} 12:00:00`, low: `${day}T03:00:00Z`, high: `${day}T15:00:00Z` },
    { name: 'secondHalf', start: `${day} 12:00:00`, end: `${next} 00:00:00`, low: `${day}T15:00:00Z`, high: `${next}T03:00:00Z` },
  ]
}
function envelopeRows(body) {
  if (Array.isArray(body)) return body
  if (!body || typeof body !== 'object' || body.error || body.success === false) fail('SOURCE_RESPONSE_INVALID')
  const candidates = ['data', 'records', 'result'].filter(key => Array.isArray(body[key]))
  if (candidates.length !== 1) fail('SOURCE_RESPONSE_INVALID')
  const rows = body[candidates[0]]
  // `total` is an observed monetary field for these two providers (it can be
  // negative), not a cardinality. Operational partition evidence is mandatory.
  for (const key of ['totalCount', 'recordsTotal', 'recordsFiltered']) {
    if (Object.hasOwn(body, key) && (!Number.isSafeInteger(body[key]) || body[key] !== rows.length)) fail('SOURCE_PAGINATION_UNPROVEN')
  }
  if (Object.hasOwn(body, 'totalPages') && body.totalPages !== 1) fail('SOURCE_PAGINATION_UNPROVEN')
  if (Object.hasOwn(body, 'hasMore') && body.hasMore !== false) fail('SOURCE_PAGINATION_UNPROVEN')
  if (body.next != null && body.next !== false && body.next !== '') fail('SOURCE_PAGINATION_UNPROVEN')
  if (body.nextPage != null && body.nextPage !== false && body.nextPage !== '') fail('SOURCE_PAGINATION_UNPROVEN')
  return rows
}
function windowIndex(rows, window) {
  if (!Array.isArray(rows) || rows.length >= MAX_ROWS) fail('SOURCE_ROW_LIMIT')
  const low = BigInt(timestamp(window.low).micros), high = BigInt(timestamp(window.high).micros), result = new Map()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('SOURCE_ROW_INVALID')
    const id = sourceId(row.id), at = BigInt(timestamp(row.fecha, true).micros)
    if (at < low || at >= high) fail('SOURCE_WINDOW_MISMATCH')
    if (result.has(id)) fail('SOURCE_ID_DUPLICATE')
    // Require all six fields to be present, including intentionally excluded
    // capital transfers. JSON primitives retain their original lexical values.
    const fields = ['id', 'username', 'creator_username', 'valor', 'detalles', 'fecha']
    if (fields.some(field => !Object.hasOwn(row, field))) fail('SOURCE_ROW_INVALID')
    result.set(id, JSON.stringify(fields.map(field => row[field])))
  }
  return result
}
function validatePartitions(datasets, day, requestedWindows = windowsForDay(day)) {
  if (!Array.isArray(datasets) || datasets.length !== 3) fail('SOURCE_PARTITION_MISMATCH')
  const windows = requestedWindows, [full, first, second] = datasets.map((rows, i) => windowIndex(rows, windows[i]))
  for (const id of first.keys()) if (second.has(id)) fail('SOURCE_PARTITION_OVERLAP')
  const union = new Map([...first, ...second])
  if (union.size !== full.size) fail('SOURCE_PARTITION_MISMATCH')
  for (const [id, fields] of full) if (union.get(id) !== fields) fail('SOURCE_PARTITION_MISMATCH')
  return { sourceIds: [...full.keys()], partitionVerified: true }
}
async function readExactResponse(response) {
  if (!response || response.ok !== true) fail('SOURCE_HTTP_FAILED')
  const type = response.headers?.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (!(type === 'application/json' || type?.endsWith('+json'))) fail('SOURCE_CONTENT_TYPE_INVALID')
  const length = response.headers?.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) fail('SOURCE_BODY_LIMIT')
  // Streaming is required: do not buffer an unbounded response with text().
  if (!response.body?.getReader) fail('SOURCE_STREAM_UNAVAILABLE')
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) { await reader.cancel(); fail('SOURCE_BODY_LIMIT') }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  return envelopeRows(parseExactJson(Buffer.concat(chunks).toString('utf8')))
}
async function fetchPartitionedDay(source, agent, day, { signal, assertActive, cutoff }) {
  const datasets = [], boundaryRows = []
  const windows = windowsForDay(day)
  if(cutoff){
    const at=timestamp(cutoff),micros=BigInt(at.micros)
    if(at.day!==day||micros<=BigInt(timestamp(windows[1].high).micros)||micros>=BigInt(timestamp(windows[0].high).micros))fail('CUTOFF_INVALID')
    const end=new Date(Date.parse(at.utc)-10800000).toISOString().slice(0,19).replace('T',' ')
    for(const i of [0,2]){windows[i]={...windows[i],end,high:at.utc}}
  }
  for (const window of windows) {
    assertActive()
    const params = new URLSearchParams({ username: agent, startDate: window.start, endDate: window.end, timezone: source.config.timezone })
    const url = `${source.baseUrl}${source.config.endpoint}?${params}`
    const response = await source._fetchWithRetry(url, {
      headers: { 'X-Api-Key': source.apiKey, 'X-Player-Token': source.playerToken,
        Accept: 'application/json, text/plain, */*', Origin: 'https://panel-skin5.zeuscasino.fun', Referer: 'https://panel-skin5.zeuscasino.fun/' },
      signal,
    }, 'decimal candidate daily window')
    const rows = await readExactResponse(response)
    if (rows.length >= MAX_ROWS) fail('SOURCE_ROW_LIMIT')
    const high = BigInt(timestamp(window.high).micros)
    // Observed API endDate is inclusive. Keep the exact end instant for the
    // following window/day; all other out-of-window timestamps still fail.
    const boundary = rows.filter(row => BigInt(timestamp(row.fecha, true).micros) === high)
    boundaryRows.push({ window: window.name, ids: boundary.map(row => sourceId(row.id)) })
    datasets.push(rows.filter(row => BigInt(timestamp(row.fecha, true).micros) !== high))
  }
  assertActive()
  const evidence = validatePartitions(datasets, day, windows)
  return { raw: datasets[0], boundaryRows, ...evidence }
}

module.exports = { windowsForDay, envelopeRows, windowIndex, validatePartitions, readExactResponse, fetchPartitionedDay }
