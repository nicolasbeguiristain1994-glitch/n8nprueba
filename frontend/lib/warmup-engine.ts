/**
 * warmup-engine.ts (v2)
 *
 * Motor de calentamiento de líneas WhatsApp con:
 *  - Rotación inteligente de mensajes (sin repetir contenido < 48h por línea)
 *  - Progresión basada en reputación (reputationScore 0-100 ajusta targetDays ±25%)
 *  - MAX_MSGS_PER_BATCH configurable por preset de personalidad y fase
 *  - Pools ampliados (24 mensajes por fase) con variedad de follow-ups
 *
 * ──────────────────────────────────────────────────────────────
 * Estrategia de progresión:
 *
 *   Día  1 → ~5 msgs/día    (establecimiento de identidad)
 *   Día  7 → ~20 msgs/día   (construcción de historial)
 *   Día 14 → ~42 msgs/día   (habilitación de marketing)
 *   Día 21 → ~65 msgs/día
 *   Día 30 → ~80 msgs/día   (límite operativo)
 *
 *   Con reputationScore > 75: targetDays × 0.80 → curva más empinada.
 *   Con reputationScore < 40: targetDays × 1.25 → curva más conservadora.
 *
 * ──────────────────────────────────────────────────────────────
 * Distribución intra-día:
 *
 *   El proceso es invocado cada ~15 min por n8n (o cron).
 *   Por cada llamada, para cada línea activa, calculamos la
 *   probabilidad de enviar en este batch:
 *
 *     p = remaining_msgs / remaining_slots
 *
 *   Esto distribuye orgánicamente los mensajes a lo largo del día
 *   sin patrones de ráfaga detectables.
 *
 * ──────────────────────────────────────────────────────────────
 * Rotación de mensajes:
 *
 *   Un store en memoria por línea rastrea los últimos mensajes enviados
 *   (ventana de 48h, máximo 20 entradas). getNextWarmupMessage() filtra
 *   el pool contra el historial reciente para evitar repeticiones detectables.
 *
 * ──────────────────────────────────────────────────────────────
 * Horario activo: 9:00 – 20:00 en el timezone de la línea.
 * Slots de 15 min en esa ventana = 44 slots/día.
 */

// ── Tipos ─────────────────────────────────────────────────────────────────────

export type WarmupPhase       = 'foundation' | 'growth' | 'maturity'
export type WarmupMessageType = 'text' | 'emoji' | 'question'
export type DelayPreset       = 'conservadora' | 'normal' | 'agresiva'

export interface WarmupMessage {
  type:    WarmupMessageType
  content: string
}

export interface BatchDecision {
  /** true si se debe enviar al menos 1 mensaje en este batch */
  shouldSend: boolean
  /** cuántos mensajes enviar en este batch */
  count: number
}

// ── Constantes ────────────────────────────────────────────────────────────────

/** Hora de inicio del bloque activo (inclusive) en el timezone local de la línea */
export const ACTIVE_HOUR_START = 9

/** Hora de fin del bloque activo (exclusive) en el timezone local de la línea */
export const ACTIVE_HOUR_END = 20

/** Minutos entre invocaciones del proceso (debe coincidir con el cron de n8n) */
export const BATCH_INTERVAL_MINUTES = 15

/** Máximo de mensajes por batch por defecto (usado cuando no se especifica preset) */
export const MAX_MSGS_PER_BATCH = 2

// ── Store de rotación de mensajes ─────────────────────────────────────────────

/** Ventana de tiempo en la que se considera que un mensaje fue enviado "recientemente" */
const ROTATION_WINDOW_MS     = 48 * 60 * 60 * 1_000
const ROTATION_HISTORY_LIMIT = 20

interface SentEntry { content: string; sentAt: number }

const lineMessageHistory = new Map<string, SentEntry[]>()

/**
 * Registra un mensaje enviado para una línea.
 * Llamar después de cada envío exitoso para mantener el historial actualizado.
 */
export function recordSentMessage(lineId: string, content: string): void {
  const existing = lineMessageHistory.get(lineId) ?? []
  existing.push({ content, sentAt: Date.now() })
  const cutoff = Date.now() - ROTATION_WINDOW_MS
  const pruned = existing.filter(e => e.sentAt > cutoff).slice(-ROTATION_HISTORY_LIMIT)
  lineMessageHistory.set(lineId, pruned)
}

/**
 * Limpia el historial de rotación de una línea (ej: al completar el warmup).
 */
export function clearLineHistory(lineId: string): void {
  lineMessageHistory.delete(lineId)
}

// ── Límite diario progresivo ──────────────────────────────────────────────────

/**
 * Calcula el límite de mensajes para el día `currentDay` de un calentamiento
 * de `targetDays` días totales.
 *
 * Curva: f(x) = START + (MAX - START) * x^0.6
 *   donde x = (currentDay - 1) / (targetDays - 1)  [0 → 1]
 *
 * Límites alcanzables según target_days:
 *   14 días → máximo ~42 msgs
 *   21 días → máximo ~63 msgs
 *   30 días → máximo ~80 msgs (cap absoluto)
 */
export function getDailyLimitForDay(currentDay: number, targetDays: number): number {
  const START_LIMIT = 5
  const MAX_LIMIT   = Math.min(targetDays * 3, 80)

  const clampedDay = Math.max(1, Math.min(currentDay, targetDays))
  const progress   = targetDays <= 1 ? 1 : (clampedDay - 1) / (targetDays - 1)
  const curved     = Math.pow(progress, 0.6)

  return Math.max(START_LIMIT, Math.round(START_LIMIT + curved * (MAX_LIMIT - START_LIMIT)))
}

/**
 * Ajusta el límite diario según la puntuación de reputación de la línea.
 *
 *   reputationScore > 75 → aceleración: targetDays × 0.80 (mín 7 días)
 *   reputationScore < 40 → desaceleración: targetDays × 1.25
 *   else                 → curva estándar
 *
 * Una reputación alta (línea con buen historial de entrega) puede progresar
 * más rápido. Una reputación baja (errores de entrega, reportes) debe ser
 * más conservadora para no comprometer el número.
 */
export function getEffectiveDailyLimit(
  currentDay:      number,
  targetDays:      number,
  reputationScore: number,
): number {
  let effectiveDays = targetDays
  if (reputationScore > 75) {
    effectiveDays = Math.max(7, Math.round(targetDays * 0.80))
  } else if (reputationScore < 40) {
    effectiveDays = Math.round(targetDays * 1.25)
  }
  return getDailyLimitForDay(currentDay, effectiveDays)
}

// ── Horario activo ────────────────────────────────────────────────────────────

/**
 * Devuelve true si la hora actual en `timezone` está dentro del bloque activo.
 */
export function isActiveHour(timezone: string, now = new Date()): boolean {
  try {
    const fmt  = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone })
    const hour = parseInt(fmt.format(now), 10)
    return hour >= ACTIVE_HOUR_START && hour < ACTIVE_HOUR_END
  } catch {
    return false
  }
}

/**
 * Devuelve cuántos slots de BATCH_INTERVAL_MINUTES restan en la ventana activa.
 * Mínimo: 1 (para evitar división por cero).
 */
export function remainingActiveSlots(timezone: string, now = new Date()): number {
  try {
    const fmt   = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: 'numeric', hour12: false, timeZone: timezone,
    })
    const parts  = fmt.formatToParts(now)
    const hour   = parseInt(parts.find(p => p.type === 'hour')!.value,   10)
    const minute = parseInt(parts.find(p => p.type === 'minute')!.value, 10)

    const minutesLeft = Math.max(0, ACTIVE_HOUR_END * 60 - (hour * 60 + minute))
    return Math.max(1, Math.floor(minutesLeft / BATCH_INTERVAL_MINUTES))
  } catch {
    return 1
  }
}

// ── Fases del warmup ──────────────────────────────────────────────────────────

export function getWarmupPhase(currentDay: number): WarmupPhase {
  if (currentDay <= 7)  return 'foundation'
  if (currentDay <= 14) return 'growth'
  return 'maturity'
}

/**
 * Ajusta la fase según la reputación de la línea.
 * Con reputación baja (<40) la línea se queda en foundation hasta el día 14
 * y en growth a partir de ahí — nunca alcanza maturity hasta mejorar.
 */
export function getWarmupPhaseForReputation(
  currentDay:      number,
  reputationScore: number,
): WarmupPhase {
  if (reputationScore < 40) {
    if (currentDay <= 14) return 'foundation'
    return 'growth'
  }
  return getWarmupPhase(currentDay)
}

// ── Batch size configurable por preset ────────────────────────────────────────

/**
 * Máximo de mensajes por batch según preset de personalidad y fase.
 *
 *   reputationScore < 40  → siempre 1 (modo de emergencia)
 *   conservadora          → 1 en cualquier fase
 *   normal                → 2 en cualquier fase
 *   agresiva              → 2 en foundation/growth, 3 en maturity
 */
export function getMaxMsgsPerBatch(
  preset:           DelayPreset,
  phase:            WarmupPhase,
  reputationScore = 50,
): number {
  if (reputationScore < 40)   return 1
  if (preset === 'conservadora') return 1
  if (preset === 'agresiva')     return phase === 'maturity' ? 3 : 2
  return 2
}

/**
 * Decide cuántos mensajes enviar en el batch actual para una línea.
 *
 * Algoritmo generalizado (válido para cualquier maxPerBatch):
 *   p      = min(remainingMsgs / remainingSlots, maxPerBatch)
 *   floor  = ⌊p⌋
 *   frac   = p − floor
 *   count  = floor + Bernoulli(frac)
 *
 * Esto da una distribución orgánica: si se necesitan 1.4 msgs/slot,
 * se envía 1 siempre y 2 el 40% de las veces.
 *
 * @param maxPerBatch - Máximo permitido (default: MAX_MSGS_PER_BATCH). Usar
 *                      getMaxMsgsPerBatch() para obtener el valor según preset.
 */
export function decideBatchSize(
  remainingMsgs:  number,
  remainingSlots: number,
  maxPerBatch = MAX_MSGS_PER_BATCH,
  rng = Math.random,
): BatchDecision {
  if (remainingMsgs <= 0) return { shouldSend: false, count: 0 }

  const p       = Math.min(remainingMsgs / remainingSlots, maxPerBatch)
  const floor   = Math.floor(p)
  const frac    = p - floor
  const extra   = frac > 0 && rng() < frac ? 1 : 0
  const count   = Math.min(floor + extra, remainingMsgs, maxPerBatch)

  return { shouldSend: count > 0, count }
}

// ── Pool de mensajes ──────────────────────────────────────────────────────────

const MESSAGE_POOLS: Record<WarmupPhase, WarmupMessage[]> = {
  foundation: [
    { type: 'text',     content: 'Hola! Cómo andás?' },
    { type: 'text',     content: 'Buen día! Todo bien por ahí?' },
    { type: 'emoji',    content: '👋' },
    { type: 'text',     content: 'Hola, te escribo desde el nuevo número' },
    { type: 'text',     content: 'Qué tal? Cómo estás?' },
    { type: 'emoji',    content: '😊 Buenas!' },
    { type: 'text',     content: 'Hey! Todo bien?' },
    { type: 'text',     content: 'Holaa, cómo va todo?' },
    { type: 'emoji',    content: '🙌 Saludos!' },
    { type: 'text',     content: 'Buen día! Espero que estés bien' },
    { type: 'question', content: 'Oye, cómo estás? Hace tiempo que no hablamos' },
    { type: 'text',     content: 'Hola! Te mando saludos' },
    { type: 'text',     content: 'Buenas! Cómo estás?' },
    { type: 'emoji',    content: '✌️ Saludos!' },
    { type: 'text',     content: 'Hola! Acá todo tranquilo' },
    { type: 'question', content: 'Todo bien por tu lado?' },
    { type: 'text',     content: 'Hey! Un saludo rápido' },
    { type: 'emoji',    content: '🤙' },
    { type: 'text',     content: 'Hola! Espero que estés muy bien' },
    { type: 'question', content: 'Cómo va? Todo bien?' },
    { type: 'text',     content: 'Buenas tardes! Cómo va todo?' },
    { type: 'text',     content: 'Holaa! Saludos desde acá' },
    { type: 'emoji',    content: '👍 Saludos!' },
    { type: 'text',     content: 'Buen día! Solo pasaba a saludar' },
  ],
  growth: [
    { type: 'text',     content: 'Hola! Espero que estés teniendo un buen día 😊' },
    { type: 'question', content: 'Qué tal tu semana? Acá todo bien!' },
    { type: 'text',     content: 'Buen día! Un saludo desde acá' },
    { type: 'question', content: 'Hey, cómo te va? Hace tiempo que no hablamos' },
    { type: 'text',     content: 'Hola! Por acá todo bien, espero que vos también' },
    { type: 'emoji',    content: '👋😊 Buenas! Cómo andás?' },
    { type: 'question', content: 'Cómo estás? Todo bien por tu lado?' },
    { type: 'text',     content: 'Holaa! Un saludo, espero que estés bien' },
    { type: 'text',     content: 'Buenas! Te mando un abrazo' },
    { type: 'question', content: 'Oye, qué tal? Todo bien?' },
    { type: 'text',     content: 'Hola! Solo quería saludarte 😊' },
    { type: 'text',     content: 'Buen día! Acá todo tranquilo, espero que vos también estés bien' },
    { type: 'question', content: 'Cómo va todo por tu lado? Acá todo excelente' },
    { type: 'text',     content: 'Hola! Qué onda? Espero que bien' },
    { type: 'emoji',    content: '🙌 Saludos! Cómo andás?' },
    { type: 'text',     content: 'Holaa! Buenas tardes, cómo te va?' },
    { type: 'question', content: 'Qué hacés? Todo bien?' },
    { type: 'text',     content: 'Hey! Espero que tengas un excelente día' },
    { type: 'question', content: 'Cómo estuvo tu semana?' },
    { type: 'text',     content: 'Buenas! Acá andando. Vos cómo estás?' },
    { type: 'text',     content: 'Hola! Pasaba a mandar un saludo 😊' },
    { type: 'question', content: 'Oye, todo bien por ahí?' },
    { type: 'text',     content: 'Buen día! Que tengas una jornada excelente' },
    { type: 'emoji',    content: '☀️ Buen día! Cómo estás?' },
  ],
  maturity: [
    { type: 'text',     content: 'Hola! Cómo andás? Por acá todo excelente 😊' },
    { type: 'question', content: 'Hey! Cómo te va? Espero que bien por tu lado' },
    { type: 'text',     content: 'Buenas! Un abrazo grande, espero que estés muy bien' },
    { type: 'question', content: 'Qué tal? Todo bien por ahí? Acá todo perfecto' },
    { type: 'text',     content: 'Hola! Te mando saludos, espero que estés teniendo un gran día' },
    { type: 'question', content: 'Oye, cómo estás? Por acá todo tranquilo' },
    { type: 'text',     content: 'Buenas! Solo pasaba a saludar 😊 Espero que estés muy bien' },
    { type: 'text',     content: 'Hola! Acá todo excelente, te mando un abrazo' },
    { type: 'question', content: 'Cómo va todo? Por acá de maravilla, espero que vos también' },
    { type: 'text',     content: 'Hey! Buen día 🌟 Espero que tengas una excelente jornada' },
    { type: 'text',     content: 'Holaa! Te mando saludos y un abrazo grande' },
    { type: 'question', content: 'Qué tal tu día? Acá todo bien, por si necesitás algo 😊' },
    { type: 'text',     content: 'Hola! Qué bueno saber de vos. Todo bien?' },
    { type: 'question', content: 'Cómo estuvo tu semana? Espero que excelente' },
    { type: 'text',     content: 'Buenas! Acá todo de maravilla. Cómo andás vos?' },
    { type: 'emoji',    content: '🌟 Buenas! Espero que estés teniendo un gran día' },
    { type: 'question', content: 'Oye, qué tal todo? Acá todo excelente!' },
    { type: 'text',     content: 'Hola! Te mando un abrazo. Espero que estés muy bien 😊' },
    { type: 'question', content: 'Cómo va todo por tu lado? Acá de maravilla' },
    { type: 'text',     content: 'Buenas tardes! Espero que tu día esté siendo increíble' },
    { type: 'text',     content: 'Holaa! Por acá todo perfecto. Vos cómo estás?' },
    { type: 'question', content: 'Qué hacés? Todo bien? Acá todo excelente 🙌' },
    { type: 'text',     content: 'Hola! Solo quería mandar un saludo y saber cómo estás' },
    { type: 'emoji',    content: '☀️ Buen día! Que tengas una jornada genial' },
  ],
}

// ── Selección de mensajes ─────────────────────────────────────────────────────

/**
 * Selecciona el próximo mensaje para una línea, evitando repetir contenido
 * enviado en las últimas 48h (via store en memoria).
 *
 * Algoritmo:
 *   1. Filtrar pool contra historial reciente de la línea + recentMessages extra.
 *   2. Si el pool filtrado está vacío → reset de historial, usar pool completo.
 *   3. Seleccionar aleatoriamente del pool filtrado y registrar el envío.
 *
 * @param lineId         - ID de la línea (para el store de historial).
 * @param phase          - Fase del warmup (determina el pool a usar).
 * @param recentMessages - Contenidos a excluir adicionalmente (session-level).
 * @param rng            - Función aleatoria (inyectable para testing).
 */
export function getNextWarmupMessage(
  lineId:          string,
  phase:           WarmupPhase,
  recentMessages:  string[] = [],
  rng = Math.random,
): WarmupMessage {
  const pool   = MESSAGE_POOLS[phase]
  const cutoff = Date.now() - ROTATION_WINDOW_MS

  const recentInStore = (lineMessageHistory.get(lineId) ?? [])
    .filter(e => e.sentAt > cutoff)
    .map(e => e.content)

  const excluded = new Set([...recentInStore, ...recentMessages])

  let candidates = pool.filter(m => !excluded.has(m.content))

  if (candidates.length === 0) {
    lineMessageHistory.set(lineId, [])
    candidates = pool
  }

  const picked = candidates[Math.floor(rng() * candidates.length)]
  recordSentMessage(lineId, picked.content)
  return picked
}

/**
 * Selecciona un mensaje para el día `currentDay`.
 * Firma original mantenida para compatibilidad con el caller existente.
 *
 * @deprecated Preferir getNextWarmupMessage() para rotación inteligente.
 */
export function pickWarmupMessage(
  currentDay: number,
  sentToday:  number,
  rng = Math.random,
): WarmupMessage {
  const phase = getWarmupPhase(currentDay)
  const pool  = MESSAGE_POOLS[phase]

  const baseIdx  = (currentDay * 3 + sentToday * 7) % pool.length
  const jitter   = rng() < 0.4 ? Math.floor(rng() * pool.length) : 0
  const finalIdx = (baseIdx + jitter) % pool.length

  return pool[finalIdx]
}

// ── Utilidades de horario ─────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000)
  const hours    = Math.floor(totalMin / 60)
  const mins     = totalMin % 60
  if (hours === 0) return `${mins}m`
  if (mins  === 0) return `${hours}h`
  return `${hours}h ${mins}m`
}

export function currentHourIn(timezone: string, now = new Date()): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone })
    return parseInt(fmt.format(now), 10)
  } catch {
    return new Date().getHours()
  }
}
