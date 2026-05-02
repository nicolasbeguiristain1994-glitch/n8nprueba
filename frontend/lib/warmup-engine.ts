/**
 * warmup-engine.ts
 *
 * Lógica pura del motor de calentamiento de líneas WhatsApp.
 * Sin dependencias de DB — solo cálculos y contenido de mensajes.
 *
 * ──────────────────────────────────────────────────────────────
 * Estrategia de progresión (2026):
 *
 *   Día  1 → ~5 msgs/día    (establecimiento de identidad)
 *   Día  7 → ~20 msgs/día   (construcción de historial)
 *   Día 14 → ~42 msgs/día   (habilitación de marketing)
 *   Día 21 → ~65 msgs/día
 *   Día 30 → ~80 msgs/día   (límite operativo)
 *
 * La curva usa una potencia cóncava (progress^0.6) que crece rápido
 * al inicio y se aplana al final, imitando el comportamiento humano
 * de un número nuevo que va ganando confianza gradualmente.
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
 * Horario activo: 9:00 – 20:00 en el timezone de la línea.
 * Slots de 15 min en esa ventana = 44 slots/día.
 */

// ── Tipos ─────────────────────────────────────────────────────────────────────

export type WarmupPhase = 'foundation' | 'growth' | 'maturity'
export type WarmupMessageType = 'text' | 'emoji' | 'question'

export interface WarmupMessage {
  type:    WarmupMessageType
  content: string
}

export interface BatchDecision {
  /** true si se debe enviar al menos 1 mensaje en este batch */
  shouldSend: boolean
  /** cuántos mensajes enviar en este batch (0, 1 ó 2) */
  count: number
}

// ── Constantes ────────────────────────────────────────────────────────────────

/** Hora de inicio del bloque activo (inclusive) en el timezone local de la línea */
export const ACTIVE_HOUR_START = 9

/** Hora de fin del bloque activo (exclusive) en el timezone local de la línea */
export const ACTIVE_HOUR_END = 20

/** Minutos entre invocaciones del proceso (debe coincidir con el cron de n8n) */
export const BATCH_INTERVAL_MINUTES = 15

/** Máximo de mensajes que se envían en un solo batch por línea */
export const MAX_MSGS_PER_BATCH = 2

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
  const progress   = targetDays <= 1
    ? 1
    : (clampedDay - 1) / (targetDays - 1)   // 0 → 1

  const curved = Math.pow(progress, 0.6)    // cóncava: crece rápido al inicio

  return Math.max(START_LIMIT, Math.round(START_LIMIT + curved * (MAX_LIMIT - START_LIMIT)))
}

// ── Horario activo ────────────────────────────────────────────────────────────

/**
 * Devuelve true si la hora actual en `timezone` está dentro del bloque activo.
 * Usa `Intl.DateTimeFormat` para resolver el timezone correctamente.
 */
export function isActiveHour(timezone: string, now = new Date()): boolean {
  try {
    const fmt  = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone })
    const hour = parseInt(fmt.format(now), 10)
    return hour >= ACTIVE_HOUR_START && hour < ACTIVE_HOUR_END
  } catch {
    // Timezone inválida → conservador: asumir que no es hora activa
    return false
  }
}

/**
 * Devuelve cuántos slots de BATCH_INTERVAL_MINUTES restan en la ventana activa
 * del día actual en el timezone dado.
 * Mínimo: 1 (para evitar división por cero).
 */
export function remainingActiveSlots(timezone: string, now = new Date()): number {
  try {
    const fmt  = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: 'numeric', hour12: false, timeZone: timezone,
    })
    const parts   = fmt.formatToParts(now)
    const hour    = parseInt(parts.find(p => p.type === 'hour')!.value,   10)
    const minute  = parseInt(parts.find(p => p.type === 'minute')!.value, 10)

    const currentMinutes = hour * 60 + minute
    const endMinutes     = ACTIVE_HOUR_END * 60

    const minutesLeft = Math.max(0, endMinutes - currentMinutes)
    return Math.max(1, Math.floor(minutesLeft / BATCH_INTERVAL_MINUTES))
  } catch {
    return 1
  }
}

// ── Decisión de batch ─────────────────────────────────────────────────────────

/**
 * Decide cuántos mensajes enviar en el batch actual para una línea.
 *
 * Algoritmo:
 *   p = remainingMsgs / remainingSlotsToday
 *
 *   Si p >= 2 → enviar 2 (aceleración al final del día)
 *   Si p >= 1 → enviar 1 con probabilidad 1, 2 con probabilidad (p-1)
 *   Si p < 1  → enviar 1 con probabilidad p, 0 con probabilidad (1-p)
 *
 * Esto da una distribución orgánica sin patrones de ráfaga.
 */
export function decideBatchSize(
  remainingMsgs:  number,
  remainingSlots: number,
  rng = Math.random,
): BatchDecision {
  if (remainingMsgs <= 0) return { shouldSend: false, count: 0 }

  const p = remainingMsgs / remainingSlots

  let count: number
  if (p >= MAX_MSGS_PER_BATCH) {
    count = MAX_MSGS_PER_BATCH
  } else if (p >= 1) {
    // Con probabilidad (p - 1) enviar 2, sino 1
    count = rng() < (p - 1) ? 2 : 1
  } else {
    // Con probabilidad p enviar 1, sino 0
    count = rng() < p ? 1 : 0
  }

  count = Math.min(count, remainingMsgs, MAX_MSGS_PER_BATCH)
  return { shouldSend: count > 0, count }
}

// ── Fases del warmup ──────────────────────────────────────────────────────────

export function getWarmupPhase(currentDay: number): WarmupPhase {
  if (currentDay <= 7)  return 'foundation'
  if (currentDay <= 14) return 'growth'
  return 'maturity'
}

// ── Pool de mensajes ──────────────────────────────────────────────────────────

/**
 * Mensajes de warmup por fase.
 * Diseñados para parecer naturales en el contexto de un número nuevo que le
 * escribe a contactos guardados. Evitan links, CTAs y contenido de marketing
 * en la fase foundation.
 */
const MESSAGE_POOLS: Record<WarmupPhase, WarmupMessage[]> = {
  foundation: [
    { type: 'text',     content: 'Hola! Cómo andas?' },
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
  ],
}

/**
 * Selecciona un mensaje aleatorio para el día `currentDay`.
 * Usa un índice con jitter para no repetir el mismo mensaje en días consecutivos.
 */
export function pickWarmupMessage(
  currentDay: number,
  sentToday:  number,
  rng = Math.random,
): WarmupMessage {
  const phase = getWarmupPhase(currentDay)
  const pool  = MESSAGE_POOLS[phase]

  // Índice base rotativo + jitter para evitar repetición
  const baseIdx  = (currentDay * 3 + sentToday * 7) % pool.length
  const jitter   = rng() < 0.4 ? Math.floor(rng() * pool.length) : 0
  const finalIdx = (baseIdx + jitter) % pool.length

  return pool[finalIdx]
}

// ── Utilidades de horario ─────────────────────────────────────────────────────

/**
 * Formatea una duración en ms a una string legible (ej: "2h 15m").
 */
export function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000)
  const hours    = Math.floor(totalMin / 60)
  const mins     = totalMin % 60
  if (hours === 0) return `${mins}m`
  if (mins  === 0) return `${hours}h`
  return `${hours}h ${mins}m`
}

/**
 * Devuelve la hora actual en el timezone dado (0–23).
 */
export function currentHourIn(timezone: string, now = new Date()): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone })
    return parseInt(fmt.format(now), 10)
  } catch {
    return new Date().getHours()
  }
}
