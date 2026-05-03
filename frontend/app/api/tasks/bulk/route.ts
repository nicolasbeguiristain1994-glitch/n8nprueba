import { NextRequest, NextResponse } from 'next/server'
import { query, withTransaction } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { isUUID } from '@/lib/validate'
import { TASK_PRIORITIES, type TaskPriority } from '@/lib/task-types'

// ── POST /api/tasks/bulk — Acciones masivas (solo admin) ──────────────────────
//
// Acciones soportadas:
//   delete   — soft-delete de las tareas seleccionadas
//   reassign — reemplazar todos los asignados por un nuevo operador
//   priority — cambiar prioridad de las tareas seleccionadas

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'tasks', 'delete')
  if (!auth.ok) return auth.response
  const { user } = auth

  if (user.role !== 'admin')
    return NextResponse.json({ error: 'Solo los administradores pueden ejecutar acciones masivas' }, { status: 403 })

  let body: {
    action?: string
    task_ids?: unknown[]
    data?: { user_id?: string; priority?: string; reason?: string }
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const { action, data } = body

  if (!action || !['delete', 'reassign', 'priority'].includes(action))
    return NextResponse.json({ error: 'Acción inválida. Opciones: delete, reassign, priority' }, { status: 400 })

  const taskIds: string[] = Array.isArray(body.task_ids)
    ? body.task_ids.filter((id): id is string => typeof id === 'string' && isUUID(id))
    : []

  if (taskIds.length === 0)
    return NextResponse.json({ error: 'Debes seleccionar al menos una tarea' }, { status: 400 })
  if (taskIds.length > 100)
    return NextResponse.json({ error: 'Máximo 100 tareas por acción masiva' }, { status: 400 })

  // Verificar que todas las tareas existen y no están eliminadas
  const existing = await query<{ id: string; deleted_at: string | null }>(
    `SELECT id, deleted_at FROM tasks WHERE id = ANY($1::uuid[])`,
    [taskIds]
  )
  const validIds = existing
    .filter(t => !t.deleted_at)
    .map(t => t.id)

  if (validIds.length === 0)
    return NextResponse.json({ error: 'Ninguna de las tareas seleccionadas está disponible' }, { status: 400 })

  try {
    let affected = 0

    // ── Soft delete ──────────────────────────────────────────────────────────
    if (action === 'delete') {
      const reason = typeof data?.reason === 'string' ? data.reason.slice(0, 500) : null

      await withTransaction(async (client) => {
        await client.query(
          `UPDATE tasks SET deleted_at = NOW(), deleted_by = $1, updated_at = NOW()
           WHERE id = ANY($2::uuid[]) AND deleted_at IS NULL`,
          [user.user_id, validIds]
        )
        for (const id of validIds) {
          await client.query(
            `INSERT INTO task_logs (task_id, user_id, user_name, action, comment)
             VALUES ($1, $2, $3, 'eliminada', $4)`,
            [id, user.user_id, user.name || user.email, reason]
          )
        }
      })
      affected = validIds.length

      void audit({ req, action: 'delete', resource: 'tasks',
        metadata: { bulk: true, count: affected, reason } })
    }

    // ── Reasignar ────────────────────────────────────────────────────────────
    else if (action === 'reassign') {
      const newUserId = data?.user_id
      if (!newUserId || !isUUID(newUserId))
        return NextResponse.json({ error: 'user_id inválido o ausente' }, { status: 400 })

      // Verificar que el usuario destino existe y está activo
      const [targetUser] = await query<{ id: string; name: string | null; is_active: boolean }>(
        `SELECT id, name, is_active FROM users WHERE id = $1`,
        [newUserId]
      )
      if (!targetUser || !targetUser.is_active)
        return NextResponse.json({ error: 'El usuario seleccionado no existe o está inactivo' }, { status: 400 })

      await withTransaction(async (client) => {
        // Reemplazar asignados (eliminar los existentes e insertar el nuevo)
        await client.query(
          `DELETE FROM task_assignees WHERE task_id = ANY($1::uuid[])`,
          [validIds]
        )
        for (const id of validIds) {
          await client.query(
            `INSERT INTO task_assignees (task_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [id, newUserId]
          )
          await client.query(
            `INSERT INTO task_logs (task_id, user_id, user_name, action)
             VALUES ($1, $2, $3, 'asignada')`,
            [id, user.user_id, user.name || user.email]
          )
        }
        await client.query(
          `UPDATE tasks SET updated_at = NOW() WHERE id = ANY($1::uuid[])`,
          [validIds]
        )
      })
      affected = validIds.length

      void audit({ req, action: 'update', resource: 'tasks',
        metadata: { bulk: true, action: 'reassign', count: affected, to_user: targetUser.name } })
    }

    // ── Cambiar prioridad ────────────────────────────────────────────────────
    else if (action === 'priority') {
      const newPriority = data?.priority as TaskPriority | undefined
      if (!newPriority || !TASK_PRIORITIES.includes(newPriority))
        return NextResponse.json({ error: `Prioridad inválida. Opciones: ${TASK_PRIORITIES.join(', ')}` }, { status: 400 })

      await withTransaction(async (client) => {
        await client.query(
          `UPDATE tasks SET priority = $1, updated_at = NOW()
           WHERE id = ANY($2::uuid[]) AND deleted_at IS NULL`,
          [newPriority, validIds]
        )
        for (const id of validIds) {
          await client.query(
            `INSERT INTO task_logs (task_id, user_id, user_name, action)
             VALUES ($1, $2, $3, 'editada')`,
            [id, user.user_id, user.name || user.email]
          )
        }
      })
      affected = validIds.length

      void audit({ req, action: 'update', resource: 'tasks',
        metadata: { bulk: true, action: 'priority', count: affected, priority: newPriority } })
    }

    return NextResponse.json({
      ok: true,
      affected,
      skipped: taskIds.length - validIds.length,
    })
  } catch (e) {
    console.error('[POST /api/tasks/bulk]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error al ejecutar la acción masiva. Intenta de nuevo.' }, { status: 500 })
  }
}
