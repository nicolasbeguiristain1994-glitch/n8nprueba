import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

// ── POST /api/notifications/mark-all-read — Marcar todas como leídas ─────────

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'dashboard', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth

  try {
    await query(
      `UPDATE notifications
       SET is_read = TRUE, read_at = NOW()
       WHERE user_id = $1 AND is_read = FALSE`,
      [user.user_id]
    )
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[POST /api/notifications/mark-all-read]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error al marcar notificaciones' }, { status: 500 })
  }
}
