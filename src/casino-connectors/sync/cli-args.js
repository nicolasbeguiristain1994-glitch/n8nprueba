'use strict'

const { isValidDate, argToday } = require('./dates')
const { AGENT_NAME_RE } = require('./agents')

const UUID_RE     = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLATFORM_RE = /^[a-z0-9]{1,30}$/
const TRIGGERS    = new Set(['cli', 'api', 'pipeline'])
const KNOWN_FLAGS = new Set([
  'platform', 'auto', 'desde', 'hasta', 'agentes', 'chunk-days', 'concurrency',
  'overlap-days', 'bootstrap-desde', 'run-id', 'trigger', 'preview',
])
const PREVIEW_FLAGS = new Set(['preview', 'platform', 'agentes', 'desde', 'hasta'])

/** Also used at the read-only entry point, before opening a DB connection. */
function validPreviewScope(opts, now = new Date()) {
  return opts?.preview === true && opts.mode === 'range'
    && ['zeus', 'bet30'].includes(opts.platform)
    && Array.isArray(opts.agentes) && opts.agentes.length === 1
    && typeof opts.agentes[0] === 'string' && AGENT_NAME_RE.test(opts.agentes[0])
    && isValidDate(opts.desde) && opts.desde >= '0001-01-01'
    && opts.desde === opts.hasta && opts.hasta < argToday(now)
    && !opts.runId && !opts.bootstrapDesde
}

// Compatibilidad: sin --auto ni --desde, la CLI siempre sincronizó desde 2020.
const LEGACY_DEFAULT_DESDE = '2020-01-01'

function intInRange(raw, name, min, max, errors) {
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) { errors.push(`--${name} debe ser un entero`); return undefined }
  const n = Number(raw)
  if (n < min || n > max) { errors.push(`--${name} debe estar entre ${min} y ${max}`); return undefined }
  return n
}

/**
 * Parsea y valida los argumentos de scripts/sync-casino-players-live.js.
 * Estricto: un flag desconocido o mal formado es error (antes se ignoraba o se
 * caía silenciosamente a un default).
 *
 * @param {string[]} argv
 * @param {{now?: Date, defaultPlatform?: string}} [ctx]
 * @returns {{ok: true, value: object} | {ok: false, errors: string[]}}
 */
function parseSyncArgs(argv, { now = new Date(), defaultPlatform = 'zeus' } = {}) {
  const errors = []
  const args   = {}
  const previewRequested = argv.some(a => a === '--preview' || a.startsWith('--preview='))

  for (const a of argv) {
    if (!a.startsWith('--')) { errors.push(`Argumento no reconocido: ${a}`); continue }
    const eq  = a.indexOf('=')
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq)
    const val = eq === -1 ? 'true' : a.slice(eq + 1)
    if (!KNOWN_FLAGS.has(key)) { errors.push(`Flag desconocido: --${key}`); continue }
    if (previewRequested && Object.hasOwn(args, key)) errors.push('Flag duplicado en preview')
    args[key] = val
  }

  const today    = argToday(now)
  const platform = args.platform ?? defaultPlatform
  if (!PLATFORM_RE.test(platform)) errors.push('--platform inválida')

  const auto = args.auto === 'true'
  if (args.auto !== undefined && args.auto !== 'true') errors.push('--auto no lleva valor')
  if (auto && args.desde) errors.push('--auto y --desde son excluyentes')
  if (auto && args.hasta) errors.push('--auto siempre termina hoy; no admite --hasta')
  if (!auto && args['bootstrap-desde']) errors.push('--bootstrap-desde solo aplica con --auto')

  const desde = auto ? undefined : (args.desde ?? LEGACY_DEFAULT_DESDE)
  const hasta = auto ? undefined : (args.hasta ?? today)
  if (!auto) {
    if (!isValidDate(desde)) errors.push('--desde debe ser una fecha YYYY-MM-DD válida')
    if (!isValidDate(hasta)) errors.push('--hasta debe ser una fecha YYYY-MM-DD válida')
    if (isValidDate(desde) && isValidDate(hasta)) {
      if (desde > hasta) errors.push('--desde no puede ser posterior a --hasta')
      if (hasta > today) errors.push(`--hasta no puede ser futura (hoy en Argentina: ${today})`)
    }
  }

  const bootstrapDesde = args['bootstrap-desde']
  if (bootstrapDesde !== undefined) {
    if (!isValidDate(bootstrapDesde)) errors.push('--bootstrap-desde debe ser una fecha YYYY-MM-DD válida')
    else if (bootstrapDesde > today) errors.push('--bootstrap-desde no puede ser futura')
  }

  let agentes
  if (args.agentes !== undefined) {
    const list = [...new Set(args.agentes.split(',').map(s => s.trim()).filter(Boolean))]
    const bad  = list.filter(a => !AGENT_NAME_RE.test(a))
    if (!list.length) errors.push('--agentes vacío')
    if (bad.length)   errors.push('--agentes contiene nombres inválidos')
    if (list.length > 50) errors.push('--agentes admite hasta 50 nombres')
    agentes = list
  }

  const runId = args['run-id']
  if (runId !== undefined && !UUID_RE.test(runId)) errors.push('--run-id debe ser un UUID')

  const triggeredBy = args.trigger ?? 'cli'
  if (!TRIGGERS.has(triggeredBy)) errors.push('--trigger debe ser cli, api o pipeline')

  const chunkDays   = intInRange(args['chunk-days'],   'chunk-days',   1, 366, errors)
  const concurrency = intInRange(args.concurrency,     'concurrency',  1, 5,   errors)
  const overlapDays = intInRange(args['overlap-days'], 'overlap-days', 0, 7,   errors)

  if (previewRequested) {
    if (args.preview !== 'true' || !args.platform || !args.desde || !args.hasta
      || !args.agentes || args.agentes.split(',').length !== 1
      || Object.keys(args).some(key => !PREVIEW_FLAGS.has(key))
      || !validPreviewScope({ preview: true, platform, mode: auto ? 'auto' : 'range', agentes, desde, hasta }, now)) {
      errors.push('Alcance de preview inválido')
    }
  }

  if (errors.length) return { ok: false, errors: previewRequested
    ? ['Preview inválido: requiere --platform=zeus|bet30, un --agentes y --desde/--hasta explícitos para un único día cerrado, sin otras opciones.']
    : errors }

  return {
    ok: true,
    value: {
      platform,
      mode: auto ? 'auto' : 'range',
      desde,
      hasta,
      agentes,
      runId: runId?.toLowerCase(),
      triggeredBy,
      bootstrapDesde,
      chunkDays,
      concurrency,
      overlapDays,
      ...(previewRequested ? { preview: true } : {}),
    },
  }
}

module.exports = { parseSyncArgs, validPreviewScope, UUID_RE }
