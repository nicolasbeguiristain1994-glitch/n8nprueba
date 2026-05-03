import { NextRequest, NextResponse } from 'next/server'
import { query, withTransaction } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { isUUID, clampStr } from '@/lib/validate'

// Transiciones de estado permitidas por rol:
// Admin:    pendiente → en_progreso, en_progreso → completada/cancelada, pendiente → cancelada
// Operator: pendiente → en_progreso, en_progreso → completada

const OPERATOR_TRANSITIONS: Record<string, string[]> = {
  pendiente:   ['en_progreso'],
  en_progreso: ['completada'],
}

const ADMIN_TRANSITIONS: Record<string, string[]> = {
  pendiente:   ['en_progreso', 'cancelada'],
  en_progreso: ['completada', 'cancelada'],
}

// ── POST /api/tasks/[id]/status — Cambiar estado ──────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const auth = await checkPermissionWithUser(req, 'tasks', 'update')
  if (!auth.ok) return auth.response
  const { user } = auth
  const isAdmin = user.role === 'admin'

  let body: { status?: string; comment?: string; cancel_reason?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const newStatus = body.status || ''
  if (!newStatus) return NextResponse.json({ error: 'El campo status es obligatorio' }, { status: 400 })

  const comment      = clampStr(body.comment, 2000) || null
  const cancelReason = clampStr(body.cancel_reason, 500) || null

  try {
    const [task] = await query<{
      id: string; status: string; title: string; deleted_at: string | null
    }>(`SELECT id, status, title, deleted_at FROM tasks WHERE id = $1`, [id])

    if (!task || task.deleted_at)
      return NextResponse.json({ error: 'Tarea no encontrada' }, { status: 404 })

    // Verificar que el operador está asignado a esta tarea
    if (!isAdmin) {
      const [assigned] = await query<{ task_id: string }>(
        `SELECT task_id FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
        [id, user.user_id]
      )
      if (!assigned) return NextResponse.json({ error: 'No tienes acceso a esta tarea' }, { status: 403 })
    }

    // Validar transición
    const allowed = isAdmin ? ADMIN_TRANSITIONS : OPERATOR_TRANSITIONS
    const fromStatus = task.status

    if (!(fromStatus in allowed) || !allowed[fromStatus].includes(newStatus)) {
      return NextResponse.json({
        error: `Transición no permitida: ${fromStatus} → ${newStatus}`,
      }, { status: 400 })
    }

    await withTransaction(async (client) => {
      const updates: string[] = ['status = $1', 'updated_at = NOW()']
      const vals: unknown[] = [newStatus]
      let pIdx = 2

      if (newStatus === 'completada') {
        updates.push(`completed_at = NOW()`, `completed_by = $${pIdx++}`)
        vals.push(user.user_id)
        if (comment) { updates.push(`completion_notes = $${pIdx++}`); vals.push(comment) }
      }
      if (newStatus === 'cancelada') {
        updates.push(`cancelled_at = NOW()`, `cancelled_by = $${pIdx++}`)
        vals.push(user.user_id)
        if (cancelReason) { updates.push(`cancel_reason = $${pIdx++}`); vals.push(cancelReason) }
      }

      vals.push(id)
      await client.query(
        `UPDATE tasks SET ${updates.join(', ')} WHERE id = $${pIdx}`,
        vals
      )

      // Mapear acción para el log
      const actionMap: Record<string, string> = {
        en_progreso: 'iniciada',
        completada:  'completada',
        cancelada:   'cancelada',
      }

      await client.query(
        `INSERT INTO task_logs (task_id, user_id, user_name, action, from_status, to_status, comment)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          user.user_id,
          user.name || user.email,
          actionMap[newStatus] || newStatus,
          fromStatus,
          newStatus,
          newStatus === 'completada' ? comment : (newStatus === 'cancelada' ? cancelReason : null),
        ]
      )
    })

    void audit({ req, action: 'update', resource: 'tasks', resource_id: id,
      metadata: { from: fromStatus, to: newStatus } })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[POST /api/tasks/[id]/status]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
