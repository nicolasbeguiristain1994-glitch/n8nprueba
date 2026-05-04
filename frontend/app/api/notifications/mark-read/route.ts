import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

// ── POST /api/notifications/mark-read — Marcar una o varias como leídas ──────
//
// Body: { ids: string[] }   ← UUIDs de notificaciones a marcar
//
// Solo marca notificaciones que pertenecen al usuario autenticado.

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'dashboard', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth

  let body: { ids?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []

  if (ids.length === 0) {
    return NextResponse.json({ error: 'Se requiere al menos un ID' }, { status: 400 })
  }

  try {
    const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ')
    await query(
      `UPDATE notifications
       SET is_read = TRUE, read_at = NOW()
       WHERE user_id = $1
         AND id IN (${placeholders})
         AND is_read = FALSE`,
      [user.user_id, ...ids]
    )
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[POST /api/notifications/mark-read]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error al marcar notificaciones' }, { status: 500 })
  }
}
