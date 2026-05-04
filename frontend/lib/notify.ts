/**
 * notify.ts — Helper centralizado para crear notificaciones internas.
 *
 * Uso: `void notify({ ... })`  ← fire-and-forget, nunca lanza excepciones.
 *
 * Respeta las preferencias del usuario antes de insertar.
 * Si el usuario desactivó ese tipo de notificación, no se persiste.
 */

import { pool } from '@/lib/db'

export type NotificationType =
  | 'tarea_asignada'
  | 'tarea_estado'
  | 'mensaje_nuevo'
  | 'campana_finalizada'
  | 'alerta_operativa'

export interface NotifyPayload {
  /** UUID del usuario destinatario */
  userId: string
  type: NotificationType
  title: string
  body?: string
  /** Ruta interna relativa, ej: '/mis-tareas' o '/tareas' */
  link?: string
  /** 'task' | 'conversation' | 'campaign' | 'line' */
  relatedType?: string
  /** UUID o identificador del recurso relacionado */
  relatedId?: string
  metadata?: Record<string, unknown>
}

// Mapeo: tipo de notificación → columna de preferencia
const PREF_COLUMN: Record<NotificationType, string> = {
  tarea_asignada:    'notify_tarea_asignada',
  tarea_estado:      'notify_tarea_estado',
  mensaje_nuevo:     'notify_mensaje_nuevo',
  campana_finalizada:'notify_campana',
  alerta_operativa:  'notify_alerta_operativa',
}

/**
 * Crea una notificación para un usuario.
 * NUNCA lanza excepciones — los errores se loguean y se ignoran.
 * Llama siempre con `void notify(...)` para no bloquear la respuesta.
 */
export async function notify(payload: NotifyPayload): Promise<void> {
  try {
    const col = PREF_COLUMN[payload.type]

    // Chequear preferencias (si no existe fila, DEFAULT = TRUE → notifica)
    const prefRows = await pool.query<{ enabled: boolean }>(
      `SELECT COALESCE(
         (SELECT ${col} FROM notification_preferences WHERE user_id = $1),
         TRUE
       ) AS enabled`,
      [payload.userId]
    )
    if (!prefRows.rows[0]?.enabled) return

    await pool.query(
      `INSERT INTO notifications
         (user_id, type, title, body, link, related_type, related_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        payload.userId,
        payload.type,
        payload.title,
        payload.body   ?? null,
        payload.link   ?? null,
        payload.relatedType ?? null,
        payload.relatedId   ?? null,
        JSON.stringify(payload.metadata ?? {}),
      ]
    )
  } catch (e) {
    console.error('[notify] error al crear notificación:', e instanceof Error ? e.message : String(e))
  }
}

/**
 * Notifica a múltiples usuarios a la vez (mismo payload, distintos destinatarios).
 * Útil para notificar a todos los asignados de una tarea.
 */
export async function notifyMany(
  userIds: string[],
  payload: Omit<NotifyPayload, 'userId'>
): Promise<void> {
  await Promise.all(userIds.map(uid => notify({ ...payload, userId: uid })))
}
