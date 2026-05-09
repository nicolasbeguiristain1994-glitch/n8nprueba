import type { MetaError } from './types'

// ─── Jerarquía de errores internos ────────────────────────────────────────────

export class CloudApiError extends Error {
  constructor(
    message:      string,
    public readonly code?:       number,
    public readonly title?:      string,
    public readonly fbtrace?:    string,
    public readonly retryable?:  boolean,
  ) {
    super(message)
    this.name = 'CloudApiError'
  }
}

export class RateLimitError extends CloudApiError {
  constructor(public readonly retryAfterMs: number) {
    super('Rate limit exceeded — máximo 20 mensajes/segundo por número', 429, 'Rate Limited', undefined, true)
    this.name = 'RateLimitError'
  }
}

export class OptOutError extends CloudApiError {
  constructor(phone: string) {
    super(`El número ${phone} ha optado por no recibir mensajes`, 131026, 'User opted out', undefined, false)
    this.name = 'OptOutError'
  }
}

export class TemplateNotApprovedError extends CloudApiError {
  constructor(templateName: string) {
    super(`La plantilla "${templateName}" no está aprobada por Meta`, 132000, 'Template not approved', undefined, false)
    this.name = 'TemplateNotApprovedError'
  }
}

export class ConversationWindowError extends CloudApiError {
  constructor() {
    super('No hay ventana de servicio abierta. Debes usar una plantilla aprobada.', 131047, 'Window closed', undefined, false)
    this.name = 'ConversationWindowError'
  }
}

export class TokenExpiredError extends CloudApiError {
  constructor() {
    super('El access token del número ha expirado', 190, 'Access token expired', undefined, false)
    this.name = 'TokenExpiredError'
  }
}

export class PhoneNumberNotRegisteredError extends CloudApiError {
  constructor(phoneNumberId: string) {
    super(`El número ${phoneNumberId} no está registrado en Cloud API`, 133000, 'Number not registered', undefined, false)
    this.name = 'PhoneNumberNotRegisteredError'
  }
}

// ─── Códigos de error de Meta y su clasificación ─────────────────────────────
// Referencia: developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes

interface ErrorMeta {
  retryable: boolean
  userMessage: string
}

const META_ERROR_MAP: Record<number, ErrorMeta> = {
  // Auth
  100:    { retryable: false, userMessage: 'Parámetro inválido en la solicitud a Meta' },
  190:    { retryable: false, userMessage: 'Token de acceso expirado o inválido' },
  200:    { retryable: false, userMessage: 'Sin permisos suficientes en la App de Meta' },

  // Rate limits
  4:      { retryable: true,  userMessage: 'Demasiadas llamadas a la API — reintentando' },
  80007:  { retryable: true,  userMessage: 'Límite de mensajes alcanzado para este número' },
  130429: { retryable: true,  userMessage: 'Rate limit de Cloud API alcanzado' },
  131048: { retryable: true,  userMessage: 'Spam rate limit — el número es marcado como spam' },

  // Mensajería
  131000: { retryable: false, userMessage: 'Error interno de Meta al enviar el mensaje' },
  131005: { retryable: false, userMessage: 'Sin permisos para enviar mensajes a este número' },
  131008: { retryable: false, userMessage: 'Parámetro requerido faltante en el mensaje' },
  131009: { retryable: false, userMessage: 'Valor de parámetro inválido en el mensaje' },
  131016: { retryable: false, userMessage: 'Servicio de Cloud API temporalmente no disponible' },
  131021: { retryable: false, userMessage: 'El número destinatario no está en WhatsApp' },
  131026: { retryable: false, userMessage: 'El destinatario ha optado por no recibir mensajes' },
  131042: { retryable: false, userMessage: 'Error de vinculación del número de teléfono' },
  131045: { retryable: false, userMessage: 'Error de registro del número de teléfono' },
  131047: { retryable: false, userMessage: 'La ventana de 24h ha expirado — usa una plantilla' },
  131051: { retryable: false, userMessage: 'Tipo de mensaje no compatible' },
  131052: { retryable: false, userMessage: 'Error al subir o acceder al media' },
  131053: { retryable: false, userMessage: 'Error de URL del media (inaccessible)' },

  // Templates
  132000: { retryable: false, userMessage: 'Plantilla no encontrada o no aprobada' },
  132001: { retryable: false, userMessage: 'Plantilla en estado no apto para envío' },
  132005: { retryable: false, userMessage: 'Traducción de plantilla inválida' },
  132007: { retryable: false, userMessage: 'Componentes de plantilla inválidos' },
  132012: { retryable: false, userMessage: 'Variables de plantilla inválidas o faltantes' },
  132015: { retryable: false, userMessage: 'El límite de plantillas del WABA ha sido alcanzado' },
  132016: { retryable: false, userMessage: 'Plantilla pausada por baja tasa de calidad' },
  132068: { retryable: false, userMessage: 'Plantilla pausada por política de Meta' },
  132069: { retryable: false, userMessage: 'Formato de plantilla inválido' },

  // Coexistence / Registro
  133000: { retryable: false, userMessage: 'El número no está registrado en Cloud API' },
  133004: { retryable: false, userMessage: 'El servidor de registro está saturado — reintenta más tarde' },
  133005: { retryable: false, userMessage: 'OTP de verificación inválido o expirado' },
  133006: { retryable: false, userMessage: 'Demasiados intentos de verificación OTP' },
  133008: { retryable: false, userMessage: 'Límite de reintentos de OTP alcanzado' },
  133009: { retryable: false, userMessage: 'OTP inválido' },
  133010: { retryable: false, userMessage: 'Error de registro del número de teléfono' },
  133015: { retryable: true,  userMessage: 'Por favor espera antes de registrar un número nuevamente' },

  // Business
  135000: { retryable: false, userMessage: 'Error genérico de Meta — revisa fbtrace_id' },
}

export function classifyMetaError(code: number): ErrorMeta {
  return META_ERROR_MAP[code] ?? { retryable: false, userMessage: `Error de Meta (código ${code})` }
}

export function fromMetaErrors(errors: MetaError[]): CloudApiError {
  const first = errors[0]
  if (!first) return new CloudApiError('Error desconocido de Meta')
  const meta = classifyMetaError(first.code)
  return new CloudApiError(
    meta.userMessage,
    first.code,
    first.title,
    undefined,
    meta.retryable,
  )
}

export function fromHttpResponse(status: number, body: Record<string, unknown>): CloudApiError {
  const err = body?.error as Record<string, unknown> | undefined
  const code = Number(err?.code ?? 0)
  const meta = classifyMetaError(code)

  if (code === 190) return new TokenExpiredError()

  return new CloudApiError(
    String(err?.message ?? meta.userMessage),
    code,
    String(err?.type ?? meta.userMessage),
    String(err?.fbtrace_id ?? ''),
    meta.retryable,
  )
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof CloudApiError) return error.retryable ?? false
  return false
}
