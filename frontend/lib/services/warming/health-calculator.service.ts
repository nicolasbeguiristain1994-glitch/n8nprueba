/**
 * HealthCalculatorService
 *
 * Calcula el score de salud (0-100) de una línea de calentamiento.
 * Servicio puro: no accede a la DB ni al reloj del sistema.
 * Todos los valores derivados del tiempo y los límites se reciben pre-calculados.
 *
 * Score = base + progressScore + trendScore + activityScore
 *               − inactivityPenalty − failurePenalty
 *
 * Caps:  banned → 0 | completed → 100 | paused → máx 40 | active → [0, 100]
 *
 * ⚠ Cambios de interfaz respecto a v1:
 *   HealthInput.daily_limit     → effectiveDailyLimit  (caller computa con getDailyLimitForDay)
 *   HealthInput.last_message_at → daysSinceLastMessage (caller computa; 0 = sin historial)
 */

import { resolveRecommendation } from './health-recommendation.service'

// ── Tipos públicos ────────────────────────────────────────────────────────────

export interface DailyStats {
  date:   string
  sent:   number
  failed: number
}

export interface HealthInput {
  warmup_status:        'active' | 'paused' | 'completed' | 'banned'
  current_day:          number
  target_days:          number
  /** Pre-calculado por el caller via getDailyLimitForDay(current_day, target_days). */
  effectiveDailyLimit:  number
  messages_sent_today:  number
  /** Días transcurridos desde el último mensaje. 0 = sin historial o mensaje reciente. */
  daysSinceLastMessage: number
  recent7days:          DailyStats[]
}

export interface HealthComponents {
  base:              number
  progressScore:     number
  trendScore:        number
  activityScore:     number
  inactivityPenalty: number
  failurePenalty:    number
}

export interface HealthResult {
  score:          number
  components:     HealthComponents
  label:          string
  color:          string
  recommendation: string
}

// ── Constantes ────────────────────────────────────────────────────────────────

const BASE_ACTIVE            = 30
const BASE_PAUSED            = 15
const MAX_PROGRESS           = 30
const MAX_TREND              = 20
const MAX_ACTIVITY           = 20
const MAX_INACTIVITY_PENALTY = 30
const MAX_FAILURE_PENALTY    = 20
const PAUSED_CAP             = 40

// ── Funciones puras de cálculo (testeables de forma aislada) ─────────────────

/** 0-30: proporción de días completados sobre el objetivo. */
export function calculateProgressScore(currentDay: number, targetDays: number): number {
  if (targetDays <= 0) return 0
  return Math.round(Math.min(currentDay / targetDays, 1) * MAX_PROGRESS)
}

/**
 * 0-20: consistencia de envíos en los últimos 7 días.
 * Un día se cuenta como activo si tuvo al menos 1 mensaje enviado.
 */
export function calculateTrendScore(recentDays: DailyStats[]): number {
  if (recentDays.length === 0) return 0
  const activeDays = recentDays.filter(d => d.sent > 0).length
  return Math.round((activeDays / 7) * MAX_TREND)
}

/** 0-20: ratio mensajes enviados hoy / cuota efectiva del día. */
export function calculateActivityScore(sentToday: number, effectiveDailyLimit: number): number {
  return Math.round(Math.min(sentToday / effectiveDailyLimit, 1) * MAX_ACTIVITY)
}

/**
 * 0-30: penalidad por inactividad prolongada.
 * A partir del día 2 sin actividad: +6 pts de penalidad por día.
 * Pasar 0 representa sin historial o actividad reciente → sin penalidad.
 */
export function calculateInactivityPenalty(daysSinceLastMessage: number): number {
  if (daysSinceLastMessage <= 2) return 0
  return Math.min(Math.round((daysSinceLastMessage - 2) * 6), MAX_INACTIVITY_PENALTY)
}

/** 0-20: penalidad proporcional a la tasa de mensajes fallidos en los últimos 7 días. */
export function calculateFailurePenalty(recentDays: DailyStats[]): number {
  const totalSent   = recentDays.reduce((s, d) => s + d.sent,   0)
  const totalFailed = recentDays.reduce((s, d) => s + d.failed, 0)
  const total       = totalSent + totalFailed
  if (total === 0) return 0
  return Math.round((totalFailed / total) * MAX_FAILURE_PENALTY)
}

// ── Servicio — orquesta componentes y construye el resultado ─────────────────

export class HealthCalculatorService {
  calculate(input: HealthInput): HealthResult {
    if (input.warmup_status === 'banned')    return this.bannedResult()
    if (input.warmup_status === 'completed') return this.completedResult()

    const components = this.buildComponents(input)
    const raw   = components.base + components.progressScore + components.trendScore
                + components.activityScore - components.inactivityPenalty - components.failurePenalty
    const score = this.clampByStatus(raw, input.warmup_status)

    return {
      score,
      components,
      label:          this.label(score),
      color:          this.color(score),
      recommendation: resolveRecommendation(components, input.warmup_status, score),
    }
  }

  private buildComponents(input: HealthInput): HealthComponents {
    const base = input.warmup_status === 'paused' ? BASE_PAUSED : BASE_ACTIVE
    // inactivityPenalty solo aplica a líneas activas; paused y otros reciben 0
    const daysSince = input.warmup_status === 'active' ? input.daysSinceLastMessage : 0
    return {
      base,
      progressScore:     calculateProgressScore(input.current_day, input.target_days),
      trendScore:        calculateTrendScore(input.recent7days),
      activityScore:     calculateActivityScore(input.messages_sent_today, input.effectiveDailyLimit),
      inactivityPenalty: calculateInactivityPenalty(daysSince),
      failurePenalty:    calculateFailurePenalty(input.recent7days),
    }
  }

  private clampByStatus(score: number, status: string): number {
    const clamped = Math.max(0, Math.min(100, score))
    return status === 'paused' ? Math.min(clamped, PAUSED_CAP) : clamped
  }

  label(score: number): string {
    if (score === 0) return 'Baneada'
    if (score < 35)  return 'Crítico'
    if (score < 60)  return 'Regular'
    if (score < 80)  return 'Buena'
    return 'Óptima'
  }

  color(score: number): string {
    if (score === 0) return 'bg-red-500'
    if (score < 35)  return 'bg-orange-400'
    if (score < 60)  return 'bg-amber-400'
    if (score < 80)  return 'bg-lime-500'
    return 'bg-green-500'
  }

  private bannedResult(): HealthResult {
    return {
      score: 0,
      components: { base: 0, progressScore: 0, trendScore: 0, activityScore: 0, inactivityPenalty: 0, failurePenalty: 0 },
      label: 'Baneada', color: 'bg-red-500',
      recommendation: 'Línea baneada. No apta para envíos. Considerar reemplazarla.',
    }
  }

  private completedResult(): HealthResult {
    return {
      score: 100,
      components: { base: BASE_ACTIVE, progressScore: MAX_PROGRESS, trendScore: MAX_TREND, activityScore: MAX_ACTIVITY, inactivityPenalty: 0, failurePenalty: 0 },
      label: 'Óptima', color: 'bg-green-500',
      recommendation: 'Calentamiento completado. Línea lista para producción.',
    }
  }
}

export const healthCalculatorService = new HealthCalculatorService()
