import { query } from '@/lib/db'
import type { ConversationWindow } from './types'

// ─── Customer Service Window (ventana de 24 horas) ───────────────────────────
//
// Meta abre una ventana de 24h cuando un cliente inicia una conversación.
// Durante esa ventana:
//   - Puedes enviar cualquier tipo de mensaje (texto libre, multimedia, etc.)
//   - No hay costo de plantilla (solo costo de sesión "service")
//
// Fuera de la ventana:
//   - SOLO puedes enviar plantillas aprobadas (UTILITY, MARKETING, AUTH)
//   - Costo de sesión "business-initiated"
//
// Coexistence agrega: mensajes enviados desde la WA Business App (echoes)
//   también extienden la ventana si son respuestas a mensajes de clientes.

const WINDOW_DURATION_MS = 24 * 60 * 60 * 1000

export async function getConversationWindow(
  phoneNumberId: string,
  contactPhone:  string,
): Promise<ConversationWindow> {
  const result = await query<{
    window_opens_at:  Date | null
    window_expires_at: Date | null
    window_type:      string | null
  }>(
    `SELECT window_opens_at, window_expires_at, window_type
     FROM cloud_conversations
     WHERE phone_number_id = $1 AND contact_phone = $2`,
    [phoneNumberId, contactPhone],
  )

  const row = result[0]
  if (!row || !row.window_expires_at) {
    return {
      isOpen:          false,
      expiresAt:       null,
      type:            null,
      canSendFree:     false,
      mustUseTemplate: true,
    }
  }

  const now     = new Date()
  const isOpen  = row.window_expires_at > now
  const type    = row.window_type as 'customer_initiated' | 'business_initiated' | null

  return {
    isOpen,
    expiresAt:       isOpen ? row.window_expires_at : null,
    type,
    canSendFree:     isOpen && type === 'customer_initiated',
    mustUseTemplate: !isOpen || type === 'business_initiated',
  }
}

// ─── Abrir / renovar la ventana cuando llega un mensaje del cliente ───────────

export async function openServiceWindow(
  phoneNumberId: string,
  contactPhone:  string,
  type:          'customer_initiated' | 'business_initiated' = 'customer_initiated',
): Promise<void> {
  const now     = new Date()
  const expires = new Date(now.getTime() + WINDOW_DURATION_MS)

  await query(
    `INSERT INTO cloud_conversations
       (phone_number_id, contact_phone, window_opens_at, window_expires_at, window_type, last_message_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $3, NOW())
     ON CONFLICT (phone_number_id, contact_phone) DO UPDATE
       SET window_opens_at  = $3,
           window_expires_at = $4,
           window_type       = $5,
           last_message_at   = $3,
           updated_at        = NOW()`,
    [phoneNumberId, contactPhone, now, expires, type],
  )
}

// ─── Cerrar ventana (expiración explícita o ban del contacto) ─────────────────

export async function closeServiceWindow(
  phoneNumberId: string,
  contactPhone:  string,
): Promise<void> {
  await query(
    `UPDATE cloud_conversations
     SET window_expires_at = NOW(), updated_at = NOW()
     WHERE phone_number_id = $1 AND contact_phone = $2`,
    [phoneNumberId, contactPhone],
  )
}

// ─── Ventanas próximas a expirar (para alertas proactivas) ───────────────────

export async function getWindowsExpiringIn(
  phoneNumberId: string,
  withinMinutes: number = 30,
): Promise<Array<{ contactPhone: string; expiresAt: Date }>> {
  const result = await query<{ contact_phone: string; window_expires_at: Date }>(
    `SELECT contact_phone, window_expires_at
     FROM cloud_conversations
     WHERE phone_number_id = $1
       AND window_expires_at BETWEEN NOW() AND NOW() + ($2 || ' minutes')::interval
       AND status = 'open'
     ORDER BY window_expires_at`,
    [phoneNumberId, String(withinMinutes)],
  )
  return result.map(r => ({ contactPhone: r.contact_phone, expiresAt: r.window_expires_at }))
}
