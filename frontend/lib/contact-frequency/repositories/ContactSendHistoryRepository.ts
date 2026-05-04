/**
 * ContactSendHistoryRepository.ts — ContactFrequencyEngine
 *
 * Acceso a la tabla contact_send_history.
 *
 * Path crítico (evaluate): getFrequencyProfile() — máx ~30ms.
 * Path de escritura (post-envío): recordSend() — idempotente, ~5ms.
 * Path de auditoría: findRecentSends() — no usar en el hot path.
 *
 * Diseño de performance:
 *   getFrequencyProfile() hace UN SOLO query con FILTER agregado.
 *   Extrae sent_today, sent_week y last_sent_at en una única vuelta a la DB,
 *   apoyándose en el índice idx_contact_send_history_contact_sent_at.
 *
 * Ventanas temporales (rolling, no calendario):
 *   "Hoy"        = últimas 24 horas desde NOW()
 *   "Esta semana" = últimos 7 días desde NOW()
 *
 * Se usan ventanas rolling en lugar de calendario (midnight / lunes) porque:
 *   ─ Son más conservadoras: nunca "reset" a las 00:00 libera el envío.
 *   ─ Son más justas: el contacto tiene siempre la misma ventana independiente de
 *     cuándo fue el primer envío del día.
 *   ─ Son más simples de implementar sin depender de timezone del servidor.
 */

import { query } from '@/lib/db'
import type {
  ContactFrequencyProfile,
  ContactSendRecord,
  RecordSendInput,
} from '../types'

// ── Tipos de filas DB ─────────────────────────────────────────────────────────

/** Fila del query agregado de getFrequencyProfile(). */
interface ProfileRow {
  sent_today:   string   // pg retorna COUNT como string
  sent_week:    string
  last_sent_at: string | null
}

/** Fila completa de contact_send_history. */
interface SendHistoryRow {
  id:                    string
  contact_id:            string
  campaign_id:           string | null
  operator_id:           string | null
  phone_number:          string
  sent_at:               string
  campaign_recipient_id: string | null
}

// ── Repositorio ───────────────────────────────────────────────────────────────

export class ContactSendHistoryRepository {

  /**
   * Obtiene el perfil completo de frecuencia de un contacto.
   *
   * Este es el método más llamado del sistema — ejecutado en cada evaluación
   * antes de enviar un mensaje. Debe ser extremadamente eficiente.
   *
   * Query design:
   *   ─ WHERE sent_at >= NOW() - 7 days: aprovecha el índice de rango para
   *     escanear solo los últimos 7 días (típicamente 0–5 filas).
   *   ─ FILTER dentro de COUNT: calcula sent_today y sent_week en un solo pass.
   *   ─ MAX(sent_at): retorna el timestamp más reciente sin subquery adicional.
   *
   * Rendimiento esperado: 1-10ms con el índice idx_contact_send_history_contact_sent_at.
   *
   * @param contactId - UUID del contacto a evaluar
   */
  async getFrequencyProfile(contactId: string): Promise<ContactFrequencyProfile> {
    const rows = await query<ProfileRow>(`
      SELECT
        COUNT(*) FILTER (WHERE sent_at >= NOW() - INTERVAL '24 hours') AS sent_today,
        COUNT(*) FILTER (WHERE sent_at >= NOW() - INTERVAL '7 days')   AS sent_week,
        MAX(sent_at)                                                    AS last_sent_at
      FROM contact_send_history
      WHERE contact_id = $1
        AND sent_at    >= NOW() - INTERVAL '7 days'
    `, [contactId])

    // rows[0] SIEMPRE existe (COUNT retorna una fila aunque no haya registros).
    const row = rows[0]

    const sentToday    = Number(row?.sent_today  ?? 0)
    const sentThisWeek = Number(row?.sent_week   ?? 0)
    const lastSentAt   = row?.last_sent_at ? new Date(row.last_sent_at) : null

    // Calcular horas transcurridas desde el último envío.
    // Math.max(0, ...) previene valores negativos por skew de reloj (< 1ms).
    const hoursSinceLastSend = lastSentAt !== null
      ? Math.max(0, (Date.now() - lastSentAt.getTime()) / (1000 * 60 * 60))
      : null

    return { sentToday, sentThisWeek, lastSentAt, hoursSinceLastSend }
  }

  /**
   * Registra un envío exitoso en el historial de frecuencia.
   *
   * Llamar ÚNICAMENTE después de confirmar que Evolution API retornó éxito.
   * NO llamar si el envío falló — contaminaría los contadores.
   *
   * Idempotencia: si campaignRecipientId ya existe en la tabla, la inserción
   * es silenciosa (ON CONFLICT DO NOTHING). Esto protege contra:
   *   ─ Llamadas dobles desde handleSuccess() en el distributor.
   *   ─ Reinicios del procesador que reprocesen un recipient ya enviado.
   *
   * @param input - Datos del envío confirmado
   */
  async recordSend(input: RecordSendInput): Promise<void> {
    await query(`
      INSERT INTO contact_send_history
        (contact_id, campaign_id, operator_id, phone_number, campaign_recipient_id, sent_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (campaign_recipient_id)
        WHERE campaign_recipient_id IS NOT NULL
      DO NOTHING
    `, [
      input.contactId,
      input.campaignId,
      input.operatorId,
      input.phoneNumber,
      input.campaignRecipientId ?? null,
    ])
  }

  /**
   * Retorna el historial de envíos recientes de un contacto.
   *
   * Uso: auditoría, panel de administración y debugging.
   * NO usar en el path de evaluación (usa getFrequencyProfile() en su lugar).
   *
   * @param contactId - UUID del contacto
   * @param days      - Ventana de días a consultar (default: 30)
   */
  async findRecentSends(contactId: string, days = 30): Promise<ContactSendRecord[]> {
    const rows = await query<SendHistoryRow>(`
      SELECT
        id, contact_id, campaign_id, operator_id,
        phone_number, sent_at, campaign_recipient_id
      FROM contact_send_history
      WHERE contact_id = $1
        AND sent_at   >= NOW() - ($2::integer * INTERVAL '1 day')
      ORDER BY sent_at DESC
      LIMIT 100
    `, [contactId, days])

    return rows.map(row => ({
      id:                    row.id,
      contact_id:            row.contact_id,
      campaign_id:           row.campaign_id,
      operator_id:           row.operator_id,
      phone_number:          row.phone_number,
      sent_at:               new Date(row.sent_at),
      campaign_recipient_id: row.campaign_recipient_id,
    }))
  }

  /**
   * Cuenta el total de envíos de un contacto en un período.
   * Conveniencia para analytics — no usar en el path de evaluación.
   *
   * @param contactId - UUID del contacto
   * @param since     - Fecha desde (inclusive)
   */
  async countSince(contactId: string, since: Date): Promise<number> {
    const rows = await query<{ total: string }>(`
      SELECT COUNT(*) AS total
      FROM contact_send_history
      WHERE contact_id = $1
        AND sent_at   >= $2
    `, [contactId, since.toISOString()])

    return Number(rows[0]?.total ?? 0)
  }
}
