/**
 * PredictiveAlertService
 *
 * Detecta condiciones de riesgo en líneas de calentamiento y genera alertas
 * con severidad clasificada. Servicio puro: no accede a la DB ni al reloj.
 *
 * Reglas de detección:
 *   ban_risk           — score bajo + tendencia descendente + fallos altos
 *   inactivity         — sin envíos > 4 días (solo líneas activas)
 *   health_drop        — caída brusca ≥ 25 pts en las últimas 48 h
 *   high_failure_rate  — tasa de fallos > 15 % con actividad significativa
 *
 * Líneas completadas o baneadas no generan alertas (estados terminales).
 */

import type { DailyStats } from './health-calculator.service'

// ── Tipos públicos ────────────────────────────────────────────────────────────

export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical'
export type AlertType     = 'ban_risk' | 'inactivity' | 'health_drop' | 'high_failure_rate'

export interface AlertLineInput {
  lineId:               string
  warmup_status:        'active' | 'paused' | 'completed' | 'banned'
  health_score:         number
  /** Días desde el último mensaje (0 = reciente o sin historial). */
  daysSinceLastMessage: number
  recent7days:          DailyStats[]
  /**
   * Historial de scores ordenado de más reciente a más antiguo.
   * index 0 = score actual, index 1 = ~24h, index 2 = ~48h, etc.
   * Mínimo 2 puntos para detección de caída.
   */
  recentHistory:        Array<{ score: number; recordedAt: string }>
}

export interface DetectedAlert {
  type:     AlertType
  severity: AlertSeverity
  message:  string
  /** Datos de contexto para persistir en warmup_alerts.data */
  data:     Record<string, unknown>
}

// ── Umbrales (exportados para testeo) ─────────────────────────────────────────

export const THRESHOLDS = {
  banRisk: {
    critical:    { maxScore: 20 },
    high:        { maxScore: 35, minDelta: -10 },
    medium:      { maxScore: 50, minDelta: -5, minFailRate: 0.20 },
  },
  inactivity: {
    critical:    { minDays: 7 },
    high:        { minDays: 4 },
  },
  healthDrop: {
    critical:    { minDrop48h: 30 },
    high:        { minDrop48h: 25 },
    medium:      { minDrop24h: 20 },
  },
  failureRate: {
    critical:    { rate: 0.50, minMessages: 5 },
    high:        { rate: 0.30, minMessages: 5 },
    medium:      { rate: 0.15, minMessages: 10 },
  },
} as const

// ── Servicio ──────────────────────────────────────────────────────────────────

export class PredictiveAlertService {
  /**
   * Evalúa una línea y devuelve todas las alertas detectadas.
   * Máximo una alerta por tipo para no generar duplicados.
   */
  detectAlerts(input: AlertLineInput): DetectedAlert[] {
    if (input.warmup_status === 'completed') return []
    if (input.warmup_status === 'banned')    return []

    return [
      this.detectBanRisk(input),
      this.detectInactivity(input),
      this.detectHealthDrop(input),
      this.detectHighFailureRate(input),
    ].filter((a): a is DetectedAlert => a !== null)
  }

  // ── Detectores privados ───────────────────────────────────────────────────

  private detectBanRisk(input: AlertLineInput): DetectedAlert | null {
    if (input.warmup_status !== 'active') return null

    const score   = input.health_score
    const delta   = this.computeHistoryDelta(input.recentHistory)
    const failRate = this.computeFailureRate(input.recent7days)

    const { banRisk } = THRESHOLDS

    if (score <= banRisk.critical.maxScore) {
      return {
        type: 'ban_risk', severity: 'critical',
        message: `Riesgo crítico de ban: score ${score}/100 — intervención inmediata requerida`,
        data: { score, historyDelta: delta, failRate: Math.round(failRate * 100) },
      }
    }

    if (score <= banRisk.high.maxScore && delta <= banRisk.high.minDelta) {
      return {
        type: 'ban_risk', severity: 'high',
        message: `Riesgo alto de ban: score ${score}/100 con caída de ${Math.abs(delta)} pts`,
        data: { score, historyDelta: delta, failRate: Math.round(failRate * 100) },
      }
    }

    if (score <= banRisk.medium.maxScore && delta <= banRisk.medium.minDelta && failRate >= banRisk.medium.minFailRate) {
      return {
        type: 'ban_risk', severity: 'medium',
        message: `Riesgo moderado de ban: score ${score}/100, tendencia ${delta > 0 ? '+' : ''}${delta} pts, fallos ${Math.round(failRate * 100)}%`,
        data: { score, historyDelta: delta, failRate: Math.round(failRate * 100) },
      }
    }

    return null
  }

  private detectInactivity(input: AlertLineInput): DetectedAlert | null {
    if (input.warmup_status !== 'active') return null

    const days = input.daysSinceLastMessage
    const { inactivity } = THRESHOLDS

    if (days >= inactivity.critical.minDays) {
      return {
        type: 'inactivity', severity: 'critical',
        message: `Inactividad crítica: ${Math.floor(days)} días sin envíos — la salud acumulada está en riesgo`,
        data: { daysSinceLastMessage: days },
      }
    }

    if (days >= inactivity.high.minDays) {
      return {
        type: 'inactivity', severity: 'high',
        message: `Inactividad prolongada: ${Math.floor(days)} días sin envíos — verificá la instancia en Evolution`,
        data: { daysSinceLastMessage: days },
      }
    }

    return null
  }

  private detectHealthDrop(input: AlertLineInput): DetectedAlert | null {
    const h = input.recentHistory
    if (h.length < 2) return null

    const current = h[0].score
    const prev24h = h[1]?.score ?? null
    const prev48h = h[2]?.score ?? null

    const { healthDrop } = THRESHOLDS

    if (prev48h !== null) {
      const drop = prev48h - current
      if (drop >= healthDrop.critical.minDrop48h) {
        return {
          type: 'health_drop', severity: 'critical',
          message: `Caída crítica de salud: −${drop} puntos en 48h (${prev48h} → ${current})`,
          data: { current, prev24h, prev48h, drop48h: drop },
        }
      }
      if (drop >= healthDrop.high.minDrop48h) {
        return {
          type: 'health_drop', severity: 'high',
          message: `Caída pronunciada de salud: −${drop} puntos en 48h (${prev48h} → ${current})`,
          data: { current, prev24h, prev48h, drop48h: drop },
        }
      }
    }

    if (prev24h !== null) {
      const drop = prev24h - current
      if (drop >= healthDrop.medium.minDrop24h) {
        return {
          type: 'health_drop', severity: 'medium',
          message: `Caída notable de salud: −${drop} puntos en 24h (${prev24h} → ${current})`,
          data: { current, prev24h, drop24h: drop },
        }
      }
    }

    return null
  }

  private detectHighFailureRate(input: AlertLineInput): DetectedAlert | null {
    const total    = input.recent7days.reduce((s, d) => s + d.sent + d.failed, 0)
    const failRate = this.computeFailureRate(input.recent7days)
    const { failureRate } = THRESHOLDS

    if (total < failureRate.critical.minMessages) return null

    if (failRate >= failureRate.critical.rate) {
      return {
        type: 'high_failure_rate', severity: 'critical',
        message: `Tasa de fallos crítica: ${Math.round(failRate * 100)}% en los últimos 7 días (${total} mensajes)`,
        data: { failRate: Math.round(failRate * 100), totalMessages: total },
      }
    }

    if (failRate >= failureRate.high.rate) {
      return {
        type: 'high_failure_rate', severity: 'high',
        message: `Tasa de fallos elevada: ${Math.round(failRate * 100)}% en los últimos 7 días`,
        data: { failRate: Math.round(failRate * 100), totalMessages: total },
      }
    }

    if (total >= failureRate.medium.minMessages && failRate >= failureRate.medium.rate) {
      return {
        type: 'high_failure_rate', severity: 'medium',
        message: `Tasa de fallos moderada: ${Math.round(failRate * 100)}% en los últimos 7 días`,
        data: { failRate: Math.round(failRate * 100), totalMessages: total },
      }
    }

    return null
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Delta entre el score más reciente y el más antiguo del array. Negativo = caída. */
  computeHistoryDelta(history: Array<{ score: number }>): number {
    if (history.length < 2) return 0
    return history[0].score - history[history.length - 1].score
  }

  /** Tasa de fallos sobre el total de mensajes del período. */
  computeFailureRate(days: DailyStats[]): number {
    const sent   = days.reduce((s, d) => s + d.sent, 0)
    const failed = days.reduce((s, d) => s + d.failed, 0)
    const total  = sent + failed
    return total === 0 ? 0 : failed / total
  }
}

export const predictiveAlertService = new PredictiveAlertService()
