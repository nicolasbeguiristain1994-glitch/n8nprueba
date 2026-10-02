'use strict'

/**
 * Descripción de errores para DB y logs.
 *
 * Regla: el texto de un error EXTERNO (API del casino, login, fetch, Postgres)
 * nunca se persiste ni se loguea. Puede ser texto libre —un cuerpo de respuesta,
 * una URL con query string, un detalle de constraint con valores— y ninguna regex
 * garantiza que no contenga un secreto. Para esos errores se guarda solo un
 * código estable y un mensaje genérico de una allowlist.
 *
 * Solo los SyncError (errores de dominio construidos por este código con valores
 * controlados: nombres de agente validados, fechas, conteos) conservan su mensaje.
 */

const MAX_LENGTH = 500

/** Errores de dominio: código estable y mensaje construido con valores controlados. */
class SyncError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SyncError'
    this.code = code
  }
}

const DOMAIN_CODES = new Set([
  'CURSOR_MISSING',
  'LEGACY_UNCLASSIFIED',
  'NO_AGENTS',
  'CONNECTOR_UNAVAILABLE',
  'INVALID_RESPONSE',
  'INTERRUPTED',
  'PREVIOUS_CHUNK_FAILED',
  'PERSISTENCE_FAILED',
  'RUN_ID_REUSED',
])

const GENERIC_MESSAGES = Object.freeze({
  AUTH:     'La plataforma rechazó la autenticación.',
  HTTP_4XX: 'La API de la plataforma rechazó la solicitud.',
  UPSTREAM: 'La API de la plataforma no respondió correctamente (reintentos agotados).',
  TIMEOUT:  'La operación no respondió a tiempo.',
  NETWORK:  'Error de red.',
  UNKNOWN:  'Error no clasificado.',
})

/** Status HTTP numérico si el error lo trae como propiedad (lo setea nuestro código). */
function httpStatusOf(err) {
  const s = err?.httpStatus
  return Number.isInteger(s) && s >= 100 && s <= 599 ? s : null
}

/** Clasifica un error en un código estable para el monitoreo. */
function classifyError(err) {
  if (err instanceof SyncError && DOMAIN_CODES.has(err.code)) return err.code

  const status = httpStatusOf(err)
  if (status === 401 || status === 403) return 'AUTH'
  if (status !== null && status >= 400 && status < 500) return 'HTTP_4XX'

  const msg = typeof err?.message === 'string' ? err.message : ''

  if (/auto-login|HTTP 40[13]\b/i.test(msg)) return 'AUTH'
  if (/HTTP 4\d\d/.test(msg))                return 'HTTP_4XX'
  if ((status !== null && status >= 500) || /HTTP 5\d\d|attempts failed/i.test(msg)) return 'UPSTREAM'
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || /timeout|timed out/i.test(msg)) {
    return 'TIMEOUT'
  }
  // Errores de socket de Node (ECONNRESET, EPIPE…) antes que SQLSTATE: EPIPE
  // también tiene 5 caracteres, pero ninguna clase SQLSTATE empieza con E.
  if (typeof err?.code === 'string' && /^E[A-Z]+$/.test(err.code))      return 'NETWORK'
  // SQLSTATE de Postgres: 5 caracteres alfanuméricos
  if (typeof err?.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) return `DB_${err.code}`

  return 'UNKNOWN'
}

/**
 * Defensa adicional para mensajes PROPIOS (SyncError): recorta y quita patrones
 * obvios. No es una garantía para texto externo — por eso describeError nunca
 * lo usa con errores que no sean SyncError.
 */
function sanitizeErrorMessage(input) {
  let s = typeof input === 'string' ? input : String(input?.message ?? input ?? '')
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > MAX_LENGTH ? `${s.slice(0, MAX_LENGTH)}…` : s
}

/**
 * Código y mensaje aptos para DB y logs.
 *
 * @returns {{code: string, message: string}}
 */
function describeError(err) {
  const code = classifyError(err)

  if (DOMAIN_CODES.has(code) && err instanceof SyncError) {
    return { code, message: sanitizeErrorMessage(err.message) }
  }

  if (code.startsWith('DB_')) {
    return { code, message: `Error de base de datos (SQLSTATE ${code.slice(3)}).` }
  }

  const status = httpStatusOf(err)
  const base   = GENERIC_MESSAGES[code] ?? GENERIC_MESSAGES.UNKNOWN
  return { code, message: status ? `${base} (HTTP ${status})` : base }
}

module.exports = { describeError, classifyError, sanitizeErrorMessage, SyncError, GENERIC_MESSAGES }
