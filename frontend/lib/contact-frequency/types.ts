/**
 * types.ts — ContactFrequencyEngine
 *
 * Contratos de datos entre capas del módulo.
 * Todos los tipos del módulo se definen aquí; ninguna otra capa los redefine.
 *
 * Convención: los tipos que mapean directamente a filas de DB (RuleRow, etc.)
 * son privados a cada repositorio. Solo los tipos de dominio se exportan aquí.
 */

// ── Decisión de envío ─────────────────────────────────────────────────────────

/**
 * Resultado de la evaluación de frecuencia.
 *
 * ALLOW  → seguro enviar ahora. Sin restricciones activas.
 * DELAY  → técnicamente posible pero riesgo moderado. Recomendado esperar.
 * BLOCK  → no enviar. Límite diario/semanal alcanzado o cool-down activo.
 */
export type FrequencyDecision = 'ALLOW' | 'DELAY' | 'BLOCK'

// ── Segmentos de casino (reflejan CHECK constraints en casino_players) ─────────

/** Segmento de monto del jugador. Refleja casino_players.seg_monto. */
export type SegMonto = 'bajo' | 'medio' | 'vip' | 'vip_medio' | 'vip_alto' | 'super_vip'

/** Segmento de actividad del jugador. Refleja casino_players.seg_actividad. */
export type SegActividad =
  | 'nuevo'
  | 'frecuente'
  | 'regular'
  | 'ocasional'
  | 'en_riesgo'
  | 'inactivo'

// ── Entidades de dominio ───────────────────────────────────────────────────────

/**
 * Regla de frecuencia de envío configurable.
 *
 * Los campos NULL actúan como comodines: una regla con operator_id=NULL
 * aplica a cualquier operador; con seg_monto=NULL aplica a cualquier segmento.
 *
 * La regla más específica (mayor número de campos non-null) tiene precedencia.
 * Ver resolveApplicableRule() en rules.ts para la lógica de resolución.
 */
export interface ContactFrequencyRule {
  /** UUID de la regla. */
  id: string
  /** Operador al que aplica. NULL = aplica a todos los operadores. */
  operator_id: string | null
  /** Segmento de monto al que aplica. NULL = aplica a todos los segmentos. */
  seg_monto: SegMonto | null
  /** Segmento de actividad al que aplica. NULL = aplica a todos los segmentos. */
  seg_actividad: SegActividad | null
  /** Máximo de mensajes en las últimas 24 horas (ventana rolling). */
  max_per_day: number
  /** Máximo de mensajes en los últimos 7 días (ventana rolling). */
  max_per_week: number
  /** Horas mínimas recomendadas entre envíos consecutivos. 0 = sin restricción. */
  min_hours_between_sends: number
  /** Soft-delete: regla inactiva es ignorada por el motor. */
  is_active: boolean
  created_at: Date
  updated_at: Date
}

/**
 * Registro de un envío confirmado a un contacto.
 * Inmutable una vez insertado.
 */
export interface ContactSendRecord {
  id: string
  contact_id: string
  campaign_id: string | null
  operator_id: string | null
  phone_number: string
  sent_at: Date
  /** Vínculo idempotente con campaign_recipients. */
  campaign_recipient_id: string | null
}

/**
 * Perfil de frecuencia calculado para un contacto en el momento de la evaluación.
 * Calculado por ContactSendHistoryRepository.getFrequencyProfile().
 */
export interface ContactFrequencyProfile {
  /** Mensajes enviados en las últimas 24 horas (rolling). */
  sentToday: number
  /** Mensajes enviados en los últimos 7 días (rolling). */
  sentThisWeek: number
  /** Fecha del último mensaje enviado. Null si es el primer envío. */
  lastSentAt: Date | null
  /**
   * Horas transcurridas desde el último mensaje enviado.
   * Null si es el primer envío. Nunca negativo.
   */
  hoursSinceLastSend: number | null
}

// ── Input / Output del motor ───────────────────────────────────────────────────

/**
 * Parámetros de entrada para ContactFrequencyEngine.evaluate().
 *
 * Los campos de segmentación (segMonto, segActividad) son opcionales.
 * Si se omiten, el motor usa reglas de menor especificidad (sin segmento).
 * Para máxima precisión, pasar los segmentos del contacto cuando estén disponibles.
 */
export interface FrequencyEvaluationInput {
  /** UUID del contacto a evaluar. */
  contactId: string
  /** UUID del operador que dispara el envío. Null si es un envío del sistema. */
  operatorId: string | null
  /** UUID de la campaña. Opcional, solo para logging/trazabilidad. */
  campaignId?: string
  /** Segmento de monto del jugador. Mejora la resolución de reglas si se provee. */
  segMonto?: SegMonto | null
  /** Segmento de actividad del jugador. Mejora la resolución de reglas si se provee. */
  segActividad?: SegActividad | null
}

/**
 * Resultado completo de ContactFrequencyEngine.evaluate().
 *
 * El campo `decision` es el que el distribuidor debe usar para tomar acción.
 * Los demás campos son para logging, auditoría y debugging.
 *
 * Risk score 0-100:
 *   0-30   → ALLOW  (bajo riesgo)
 *   31-60  → DELAY  (riesgo moderado — continuar con precaución)
 *   61-100 → BLOCK  (alto riesgo — no enviar)
 */
export interface FrequencyEvaluationResult {
  /** Acción recomendada. Ver FrequencyDecision. */
  decision: FrequencyDecision
  /**
   * Score cuantitativo de riesgo (0-100).
   * Útil para métricas y ajuste de umbrales.
   */
  riskScore: number
  /**
   * Explicación humano-legible de la decisión.
   * Incluye contadores actuales vs límites aplicables.
   * Apto para loguear o guardar como error_detail en campaign_recipients.
   */
  reason: string
  /** Estado de frecuencia del contacto en el momento de la evaluación. */
  profile: ContactFrequencyProfile
  /** Regla que se aplicó para tomar la decisión. */
  applicableRule: ContactFrequencyRule
  /** Momento exacto de la evaluación (para auditoría). */
  evaluatedAt: Date
}

/**
 * Input para ContactFrequencyEngine.recordSend().
 * Llamar solo después de confirmar envío exitoso desde Evolution API.
 */
export interface RecordSendInput {
  contactId: string
  campaignId: string | null
  operatorId: string | null
  phoneNumber: string
  /**
   * ID del campaign_recipient correspondiente.
   * Si se provee, garantiza idempotencia: doble llamada = no-op.
   */
  campaignRecipientId?: string
}
