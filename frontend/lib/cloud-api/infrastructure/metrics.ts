// Métricas estructuradas para el módulo de Cloud API.
//
// Estrategia: métricas en memoria con exportación Prometheus-compatible
// vía GET /api/cloud/metrics. Sin dependencia de prom-client (no compatible
// con Edge Runtime de Next.js). Para producción con k8s, sustituir por prom-client
// en un endpoint separado fuera del Edge runtime.
//
// Para exportar a Grafana/Prometheus en producción:
//   1. Instalar prom-client: npm i prom-client
//   2. Crear /api/metrics/route.ts que retorne registry.metrics()
//   3. Configurar scrape en prometheus.yml

interface Counter {
  value:  number
  labels: Record<string, string>
}

interface Histogram {
  sum:    number
  count:  number
  labels: Record<string, string>
}

class MetricsRegistry {
  private counters:   Map<string, Counter>   = new Map()
  private histograms: Map<string, Histogram> = new Map()

  // ─── Contadores ─────────────────────────────────────────────────────────────

  inc(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = this.key(name, labels)
    const existing = this.counters.get(key)
    if (existing) {
      existing.value += value
    } else {
      this.counters.set(key, { value, labels })
    }
  }

  observe(name: string, labels: Record<string, string>, value: number): void {
    const key      = this.key(name, labels)
    const existing = this.histograms.get(key)
    if (existing) {
      existing.sum   += value
      existing.count += 1
    } else {
      this.histograms.set(key, { sum: value, count: 1, labels })
    }
  }

  // ─── Exportación Prometheus text format ───────────────────────────────────

  toPrometheusText(): string {
    const lines: string[] = []

    for (const [key, c] of this.counters) {
      const labelStr = this.labelsToString(c.labels)
      lines.push(`cloud_api_${key}{${labelStr}} ${c.value}`)
    }

    for (const [key, h] of this.histograms) {
      const labelStr = this.labelsToString(h.labels)
      lines.push(`cloud_api_${key}_sum{${labelStr}} ${h.sum}`)
      lines.push(`cloud_api_${key}_count{${labelStr}} ${h.count}`)
      if (h.count > 0) {
        lines.push(`cloud_api_${key}_avg{${labelStr}} ${(h.sum / h.count).toFixed(2)}`)
      }
    }

    return lines.join('\n')
  }

  toJSON(): Record<string, unknown> {
    return {
      counters:   Object.fromEntries(this.counters),
      histograms: Object.fromEntries(this.histograms),
      timestamp:  new Date().toISOString(),
    }
  }

  private key(name: string, labels: Record<string, string>): string {
    const labelPart = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')
    return labelPart ? `${name}|${labelPart}` : name
  }

  private labelsToString(labels: Record<string, string>): string {
    return Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')
  }
}

// Singleton de proceso — compartido por todos los módulos
const registry = new MetricsRegistry()

export const cloudMetrics = {

  // ─── Mensajes ──────────────────────────────────────────────────────────────

  messageSent(phoneNumberId: string, type: string, latencyMs: number): void {
    registry.inc('messages_sent_total', { phone_number_id: phoneNumberId, type })
    registry.observe('message_send_latency_ms', { phone_number_id: phoneNumberId, type }, latencyMs)
  },

  messageFailed(phoneNumberId: string, type: string, errorCode?: number): void {
    registry.inc('messages_failed_total', {
      phone_number_id: phoneNumberId,
      type,
      error_code: String(errorCode ?? 'unknown'),
    })
  },

  messageQueued(phoneNumberId: string, type: string): void {
    registry.inc('messages_queued_total', { phone_number_id: phoneNumberId, type })
  },

  messageReceived(phoneNumberId: string, type: string): void {
    registry.inc('messages_received_total', { phone_number_id: phoneNumberId, type })
  },

  // ─── Delivery status ──────────────────────────────────────────────────────

  deliveryStatus(phoneNumberId: string, status: string): void {
    registry.inc('delivery_status_total', { phone_number_id: phoneNumberId, status })
  },

  // ─── Coexistence ──────────────────────────────────────────────────────────

  echoReceived(phoneNumberId: string): void {
    registry.inc('smb_echoes_total', { phone_number_id: phoneNumberId })
  },

  syncCompleted(phoneNumberId: string, syncType: string): void {
    registry.inc('coexistence_sync_completed_total', { phone_number_id: phoneNumberId, sync_type: syncType })
  },

  syncFailed(phoneNumberId: string, syncType: string): void {
    registry.inc('coexistence_sync_failed_total', { phone_number_id: phoneNumberId, sync_type: syncType })
  },

  // ─── Onboarding ───────────────────────────────────────────────────────────

  numberOnboarded(phoneNumberId: string, result: 'direct' | 'otp_pending'): void {
    registry.inc('numbers_onboarded_total', { result })
  },

  // ─── Templates ────────────────────────────────────────────────────────────

  templateStatusUpdated(name: string, event: string): void {
    registry.inc('template_status_updates_total', { event })
  },

  // ─── Compliance ───────────────────────────────────────────────────────────

  optOut(phoneNumberId: string, reason: string): void {
    registry.inc('opt_outs_total', { phone_number_id: phoneNumberId, reason })
  },

  // ─── Circuit breaker ──────────────────────────────────────────────────────

  circuitBreakerOpened(key: string): void {
    registry.inc('circuit_breaker_opened_total', { key })
  },

  // ─── Export ───────────────────────────────────────────────────────────────

  toPrometheusText: () => registry.toPrometheusText(),
  toJSON:           () => registry.toJSON(),
}
