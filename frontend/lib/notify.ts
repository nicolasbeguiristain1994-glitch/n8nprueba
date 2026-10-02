import { notificationScope } from '@/lib/notification-visibility'
import type { SessionUser } from '@/lib/auth'
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
    const {rows: [recipient]} = await pool.query<SessionUser>(
      `SELECT id AS user_id, role, sectors, allowed_agents, is_super_admin FROM users WHERE id=$1 AND is_active=TRUE`, [payload.userId])
    if (!recipient) return
    const scope = await notificationScope(recipient)
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

    const values = [payload.userId, payload.type, payload.title, payload.body ?? null,
      payload.link ?? null, payload.relatedType ?? null, payload.relatedId ?? null, JSON.stringify(payload.metadata ?? {})]
    const p = (n: number) => `$${scope.params.length + n}`
    await pool.query(`${scope.cte}
      INSERT INTO notifications (user_id,type,title,body,link,related_type,related_id,metadata)
      SELECT ${p(1)}::uuid,${p(2)},${p(3)},${p(4)},${p(5)},related_type,related_id,${p(8)}::jsonb
      FROM (SELECT ${p(6)}::text AS related_type, ${p(7)}::text AS related_id) notifications
      WHERE ${scope.sql}`, [...scope.params, ...values])

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
