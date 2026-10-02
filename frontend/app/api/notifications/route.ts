import { notificationScope } from '@/lib/notification-visibility'
import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkSessionWithUser } from '@/lib/permissions'

// ── GET /api/notifications — Bandeja del usuario autenticado ─────────────────
//
// Query params:
//   ?unread_only=true   → solo no leídas (default: false)
//   ?limit=20           → máx resultados (default: 30, máx: 50)
//   ?offset=0
//
// Cada usuario ve SOLO sus propias notificaciones.
// No requiere sector específico — cualquier usuario autenticado puede ver las suyas.

export async function GET(req: NextRequest) {
  const auth = await checkSessionWithUser(req)
  if (!auth.ok) return auth.response
  const user = auth.user

  const url        = req.nextUrl
  const unreadOnly = url.searchParams.get('unread_only') === 'true'
  const limit      = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')  || 30)))
  const offset     = Math.max(0,              Number(url.searchParams.get('offset') || 0))

  try {
    type NotifRow = {
      id: string
      type: string
      title: string
      body: string | null
      link: string | null
      related_type: string | null
      related_id: string | null
      is_read: boolean
      read_at: string | null
      created_at: string
    }

    const scope = await notificationScope(user)
    const conditions = ['user_id = $2', scope.sql]
    const params = scope.params
    let pIdx = params.length + 1

    if (unreadOnly) {
      conditions.push('is_read = FALSE')
    }

    const where = `WHERE ${conditions.join(' AND ')}`

    const notifications = await query<NotifRow>(`
      ${scope.cte}
      SELECT id, type, title, body, link, related_type, related_id,
             is_read, read_at, created_at
      FROM notifications
      ${where}
      ORDER BY created_at DESC
      LIMIT $${pIdx++} OFFSET $${pIdx++}
    `, [...params, limit, offset])

    const [countRow] = await query<{ total: string; unread: string }>(`
      ${scope.cte}
      SELECT
        COUNT(*)::text                              AS total,
        COUNT(*) FILTER (WHERE is_read = FALSE)::text AS unread
      FROM notifications
      WHERE user_id = $2 AND ${scope.sql}
    `, params)

    return NextResponse.json({
      notifications,
      total:  Number(countRow?.total  ?? 0),
      unread: Number(countRow?.unread ?? 0),
    })
  } catch (e) {
    console.error('[GET /api/notifications]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error al obtener notificaciones' }, { status: 500 })
  }
}
