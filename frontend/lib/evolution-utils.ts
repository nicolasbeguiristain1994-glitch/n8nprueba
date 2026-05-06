/**
 * evolution-utils.ts
 *
 * Helpers de parseo para respuestas de Evolution API v2.
 *
 * Evolution v2 devuelve distintos shapes según la versión del build:
 *
 * Shape A — fetchInstances normal (más común):
 *   [{ instance: { instanceName, state }, ownerJid, profileName }]
 *
 * Shape B — algunos builds con connectionStatus anidado:
 *   [{ instance: { instanceName, status }, connectionStatus: { state } }]
 *
 * Shape C — builds v1-compat o respuesta plana:
 *   { instanceName, state, ownerJid }
 *
 * Shape D — instancia no encontrada:
 *   [] (array vacío) | HTTP 404
 *
 * No asumir ningún shape en particular — probar todos en orden.
 */

export type InstanceState = 'open' | 'connecting' | 'close' | 'notFound'

export interface ParsedInstance {
  state:        InstanceState
  phone_number: string | null
  raw:          Record<string, unknown> | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asObj(v: any): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null
}

/**
 * Extrae el estado de conexión de un objeto de instancia Evolution.
 * Normaliza a uno de los 4 estados canónicos.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractState(inst: any): InstanceState {
  const inner   = asObj(inst?.instance)
  const connSt  = asObj(inst?.connectionStatus)

  const raw: string = (
    inner?.state   ??
    inner?.status  ??
    connSt?.state  ??
    inst?.state    ??
    inst?.status   ??
    'close'
  ) as string

  const s = String(raw).toLowerCase()
  if (s === 'open')       return 'open'
  if (s === 'connecting') return 'connecting'
  return 'close'
}

/**
 * Extrae el número de teléfono del ownerJid en formato +{digits}.
 * Prueba todos los campos conocidos donde puede aparecer.
 * Retorna null si no está disponible (normal en estados close/connecting).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractPhone(inst: any): string | null {
  const inner = asObj(inst?.instance)

  const candidates: unknown[] = [
    inst?.ownerJid,
    inner?.ownerJid,
    inner?.owner,
    inst?.number,
    inst?.phoneNumber,
  ]

  for (const c of candidates) {
    if (typeof c === 'string' && c.includes('@')) {
      const digits = c.split('@')[0]
      if (digits) return `+${digits}`
    }
    // Algunos builds devuelven el número sin @, solo dígitos
    if (typeof c === 'string' && /^\d{7,15}$/.test(c)) {
      return `+${c}`
    }
  }
  return null
}

/**
 * Parsea la respuesta completa de GET /instance/fetchInstances.
 *
 * @param httpStatus - Código HTTP de la respuesta (404 → notFound inmediato)
 * @param body       - Cuerpo ya parseado a JSON (puede ser array u objeto)
 */
export function parseInstancesResponse(
  httpStatus: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any,
): ParsedInstance {
  if (httpStatus === 404) {
    return { state: 'notFound', phone_number: null, raw: null }
  }

  // Array vacío → instancia no encontrada
  if (Array.isArray(body) && body.length === 0) {
    return { state: 'notFound', phone_number: null, raw: null }
  }

  const inst = Array.isArray(body) ? body[0] : body
  const raw  = asObj(inst)

  if (!raw) {
    return { state: 'notFound', phone_number: null, raw: null }
  }

  const state        = extractState(raw)
  const phone_number = state === 'open' ? extractPhone(raw) : null

  return { state, phone_number, raw }
}
