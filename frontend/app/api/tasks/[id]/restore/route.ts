import { NextRequest, NextResponse } from 'next/server'
import { query, withTransaction } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { isUUID } from '@/lib/validate'

// ── POST /api/tasks/[id]/restore — Restaurar tarea eliminada (solo admin) ──────
//
// Limpia deleted_at y deleted_by, vuelve el status a 'pendiente' si estaba
// eliminada (el status previo se conserva en task_logs).
// Registra entrada 'restaurada' en task_logs.

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const auth = await checkPermissionWithUser(req, 'tasks', 'update')
  if (!auth.ok) return auth.response
  const { user } = auth

  if (user.role !== 'admin')
    return NextResponse.json(
      { error: 'Solo los administradores pueden restaurar tareas' },
      { status: 403 }
    )

  try {
    const [task] = await query<{
      id: string; title: string; status: string; deleted_at: string | null
    }>(
      `SELECT id, title, status, deleted_at FROM tasks WHERE id = $1`,
      [id]
    )

    if (!task)
      return NextResponse.json({ error: 'Tarea no encontrada' }, { status: 404 })

    if (!task.deleted_at)
      return NextResponse.json({ error: 'La tarea no está eliminada' }, { status: 400 })

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE tasks
         SET deleted_at = NULL,
             deleted_by = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [id]
      )

      await client.query(
        `INSERT INTO task_logs (task_id, user_id, user_name, action, to_status, comment)
         VALUES ($1, $2, $3, 'restaurada', $4, 'Tarea restaurada por administrador')`,
        [id, user.user_id, user.name || user.email, task.status]
      )
    })

    void audit({
      req,
      action: 'update',
      resource: 'tasks',
      resource_id: id,
      metadata: { action: 'restore', title: task.title },
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[POST /api/tasks/[id]/restore]', e instanceof Error ? e.message : e)
    return NextResponse.json(
      { error: 'No se pudo restaurar la tarea. Intenta de nuevo.' },
      { status: 500 }
    )
  }
}
