/**
 * Motor de conversaciones entre líneas — lógica de timing y ramp-up.
 *
 * Reglas de delay:
 *   Burst (mismo speaker, 2+ mensajes seguidos): 15-45 seg
 *   Turno (cambio de speaker): 2-8 min
 *   Ambos llevan un jitter gaussiano leve para evitar patrones detectables.
 *
 * Ramp-up de conversaciones por día (basado en current_day de la línea):
 *   Semana 1 (días 1-7):   2-3 conversaciones por línea
 *   Semana 2 (días 8-14):  4-5 conversaciones por línea
 *   Semana 3+ (días 15+):  6-8 conversaciones por línea
 */

// ── Constantes de delay ───────────────────────────────────────────────────────

const BURST_DELAY_MIN_S  = 15   // mismo speaker, escribiendo más
const BURST_DELAY_MAX_S  = 45

const TURN_DELAY_MIN_S   = 120  // cambio de speaker, leyendo + pensando + escribiendo
const TURN_DELAY_MAX_S   = 480

/** Jitter ±15 % para romper periodicidad */
const JITTER = 0.15

// ── Helpers ───────────────────────────────────────────────────────────────────

function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1))
}

/** Aplica jitter ±JITTER % al valor base */
function withJitter(base: number): number {
  const factor = 1 + (Math.random() * 2 - 1) * JITTER
  return Math.max(1, Math.round(base * factor))
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Calcula el delay en segundos antes del próximo paso.
 *
 * @param currentSpeaker  alias del paso que se acaba de enviar
 * @param nextSpeaker     alias del próximo paso
 */
export function getNextStepDelaySeconds(
  currentSpeaker: string,
  nextSpeaker:    string,
): number {
  const isBurst = currentSpeaker === nextSpeaker
  const base    = isBurst
    ? randomBetween(BURST_DELAY_MIN_S, BURST_DELAY_MAX_S)
    : randomBetween(TURN_DELAY_MIN_S,  TURN_DELAY_MAX_S)

  return withJitter(base)
}

/**
 * Cuántas conversaciones debería tener una línea en el día actual.
 * Retorna un número aleatorio dentro del rango de la semana correspondiente.
 *
 * Semana 1 → 2-3 | Semana 2 → 4-5 | Semana 3+ → 6-8
 */
export function getDailyConversationTarget(currentDay: number): number {
  if (currentDay <= 7)  return randomBetween(2, 3)
  if (currentDay <= 14) return randomBetween(4, 5)
  return randomBetween(6, 8)
}

/**
 * Cuántas conversaciones activas tiene margen una línea de iniciar hoy,
 * dado su cuota diaria y las conversaciones ya programadas.
 */
export function remainingConversationSlots(
  currentDay:      number,
  alreadyScheduled: number,
): number {
  const target = getDailyConversationTarget(currentDay)
  return Math.max(0, target - alreadyScheduled)
}

/**
 * Timestamp del próximo envío, dado el delay en segundos desde ahora.
 */
export function nextSendAt(delaySeconds: number): string {
  return new Date(Date.now() + delaySeconds * 1000).toISOString()
}
