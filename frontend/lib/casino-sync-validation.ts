/** Input validation for the casino synchronization endpoint. */

const AR_OFFSET_MS = 3 * 3_600_000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function argToday(now: Date = new Date()): string {
  return new Date(now.getTime() - AR_OFFSET_MS).toISOString().slice(0, 10)
}

export function isValidIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

function daysInclusive(desde: string, hasta: string): number {
  const ms = new Date(`${hasta}T12:00:00Z`).getTime() - new Date(`${desde}T12:00:00Z`).getTime()
  return Math.round(ms / 86_400_000) + 1
}

// ── Validación del POST de sync ───────────────────────────────────────────────

/** Plataformas con conector implementado (src/casino-connectors/index.js). */
export const SUPPORTED_SYNC_PLATFORMS = ['zeus', 'bet30'] as const
export type SyncPlatform = typeof SUPPORTED_SYNC_PLATFORMS[number]

const KNOWN_PLATFORMS = ['zeus', 'bet30', 'ganamos', 'argenbet'] as const

export const AGENT_NAME_RE = /^[A-Za-z0-9_.-]{1,50}$/
export const MAX_API_AGENTS = 20
export const MAX_API_RANGE_DAYS = 366

export interface SyncRequest {
  platform: SyncPlatform
  mode:     'auto' | 'range'
  desde:    string | null
  hasta:    string | null
  agentes:  string[] | null
}

export type SyncRequestValidation =
  | { ok: true;  value: SyncRequest }
  | { ok: false; error: string }

export function validateSyncRequest(params: URLSearchParams, now: Date = new Date()): SyncRequestValidation {
  const platform = params.get('platform')?.trim() || 'zeus'

  if (!(KNOWN_PLATFORMS as readonly string[]).includes(platform)) {
    return { ok: false, error: `Plataforma inválida para sync. Valores permitidos: ${SUPPORTED_SYNC_PLATFORMS.join(', ')}` }
  }
  if (!(SUPPORTED_SYNC_PLATFORMS as readonly string[]).includes(platform)) {
    return {
      ok: false,
      error: `La plataforma "${platform}" todavía no tiene conector de sync. Valores permitidos: ${SUPPORTED_SYNC_PLATFORMS.join(', ')}`,
    }
  }

  const desde = params.get('desde')?.trim() || null
  const hasta = params.get('hasta')?.trim() || null
  const today = argToday(now)

  if (hasta && !desde) return { ok: false, error: '"hasta" requiere "desde"' }
  if (desde && !isValidIsoDate(desde)) return { ok: false, error: '"desde" debe ser una fecha YYYY-MM-DD válida' }
  if (hasta && !isValidIsoDate(hasta)) return { ok: false, error: '"hasta" debe ser una fecha YYYY-MM-DD válida' }

  if (desde) {
    const end = hasta ?? today
    if (desde > end)  return { ok: false, error: '"desde" no puede ser posterior a "hasta"' }
    if (end > today)  return { ok: false, error: `"hasta" no puede ser futura (hoy en Argentina: ${today})` }
    if (daysInclusive(desde, end) > MAX_API_RANGE_DAYS) {
      return { ok: false, error: `El rango no puede superar ${MAX_API_RANGE_DAYS} días desde la API; usar la CLI para cargas históricas` }
    }
  }

  let agentes: string[] | null = null
  const rawAgentes = params.get('agentes')
  if (rawAgentes !== null) {
    const list = [...new Set(rawAgentes.split(',').map(a => a.trim()).filter(Boolean))]
    if (!list.length) return { ok: false, error: '"agentes" está vacío' }
    if (list.length > MAX_API_AGENTS) return { ok: false, error: `"agentes" admite hasta ${MAX_API_AGENTS} nombres` }
    if (list.some(a => !AGENT_NAME_RE.test(a))) return { ok: false, error: '"agentes" contiene nombres inválidos' }
    agentes = list
  }

  return {
    ok: true,
    value: {
      platform: platform as SyncPlatform,
      mode:     desde ? 'range' : 'auto',
      desde,
      hasta:    desde ? (hasta ?? today) : null,
      agentes,
    },
  }
}

