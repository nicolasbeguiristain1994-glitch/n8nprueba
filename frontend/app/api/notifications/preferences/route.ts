import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

// ── GET /api/notifications/preferences — Preferencias del usuario ─────────────

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'dashboard', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth

  try {
    const [row] = await query<{
      notify_tarea_asignada: boolean
      notify_tarea_estado: boolean
      notify_mensaje_nuevo: boolean
      notify_campana: boolean
      notify_alerta_operativa: boolean
    }>(
      `SELECT notify_tarea_asignada, notify_tarea_estado, notify_mensaje_nuevo,
              notify_campana, notify_alerta_operativa
       FROM notification_preferences WHERE user_id = $1`,
      [user.user_id]
    )

    // Si no existe fila, devolver defaults (todo TRUE)
    return NextResponse.json(row ?? {
      notify_tarea_asignada:   true,
      notify_tarea_estado:     true,
      notify_mensaje_nuevo:    true,
      notify_campana:          true,
      notify_alerta_operativa: true,
    })
  } catch (e) {
    console.error('[GET /api/notifications/preferences]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error al obtener preferencias' }, { status: 500 })
  }
}

// ── PUT /api/notifications/preferences — Actualizar preferencias ──────────────
//
// Body: { notify_tarea_asignada?: bool, notify_tarea_estado?: bool, ... }

export async function PUT(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'dashboard', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const ALLOWED = [
    'notify_tarea_asignada',
    'notify_tarea_estado',
    'notify_mensaje_nuevo',
    'notify_campana',
    'notify_alerta_operativa',
  ]

  const updates: string[] = []
  const values: unknown[]  = [user.user_id]
  let pIdx = 2

  for (const col of ALLOWED) {
    if (col in body && typeof body[col] === 'boolean') {
      updates.push(`${col} = $${pIdx++}`)
      values.push(body[col])
    }
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: 'No hay campos válidos para actualizar' }, { status: 400 })
  }

  try {
    await query(
      `INSERT INTO notification_preferences (user_id, ${ALLOWED.join(', ')})
       VALUES ($1, TRUE, TRUE, TRUE, TRUE, TRUE)
       ON CONFLICT (user_id) DO UPDATE
       SET ${updates.join(', ')}, updated_at = NOW()`,
      values
    )
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[PUT /api/notifications/preferences]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error al guardar preferencias' }, { status: 500 })
  }
}
