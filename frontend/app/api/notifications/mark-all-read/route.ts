import { notificationScope } from '@/lib/notification-visibility'
import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkSessionWithUser } from '@/lib/permissions'

// ── POST /api/notifications/mark-all-read — Marcar todas como leídas ─────────

export async function POST(req: NextRequest) {
  const auth = await checkSessionWithUser(req)
  if (!auth.ok) return auth.response
  const user = auth.user

  try {
    const scope = await notificationScope(user)
    await query(
      `${scope.cte} UPDATE notifications
       SET is_read = TRUE, read_at = NOW()
       WHERE user_id = $2 AND ${scope.sql} AND is_read = FALSE`,
      scope.params
    )
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[POST /api/notifications/mark-all-read]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error al marcar notificaciones' }, { status: 500 })
  }
}
