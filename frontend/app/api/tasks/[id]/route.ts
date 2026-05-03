import { NextRequest, NextResponse } from 'next/server'
import { query, withTransaction } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { isUUID, clampStr } from '@/lib/validate'
import {
  TASK_TYPES, TASK_PRIORITIES,
  type TaskType, type TaskPriority,
  validateRelatedData,
} from '@/lib/task-types'

// ── GET /api/tasks/[id] — Detalle con historial ───────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const auth = await checkPermissionWithUser(req, 'tasks', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth
  const isAdmin = user.role === 'admin'

  try {
    const [task] = await query<{
      id: string; title: string; description: string | null; type: string
      priority: string; status: string; due_date: string | null; scheduled_at: string | null
      related_data: Record<string, unknown>; notes: string | null
      created_by: string | null; created_by_name: string | null
      created_at: string; updated_at: string
      completed_at: string | null; completed_by: string | null; completed_by_name: string | null
      completion_notes: string | null; cancelled_at: string | null; cancelled_by: string | null
      cancelled_by_name: string | null; cancel_reason: string | null
      deleted_at: string | null; deleted_by: string | null
      assignees_json: unknown
    }>(`
      SELECT
        t.id, t.title, t.description, t.type, t.priority, t.status,
        t.due_date, t.scheduled_at, t.related_data, t.notes,
        t.created_by, cb.name  AS created_by_name,
        t.created_at, t.updated_at,
        t.completed_at, t.completed_by, cpb.name AS completed_by_name, t.completion_notes,
        t.cancelled_at, t.cancelled_by, cnb.name AS cancelled_by_name, t.cancel_reason,
        t.deleted_at,  t.deleted_by,
        COALESCE(
          (SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'email', u.email))
           FROM task_assignees ta JOIN users u ON u.id = ta.user_id
           WHERE ta.task_id = t.id),
          '[]'::json
        ) AS assignees_json
      FROM tasks t
      LEFT JOIN users cb  ON cb.id  = t.created_by
      LEFT JOIN users cpb ON cpb.id = t.completed_by
      LEFT JOIN users cnb ON cnb.id = t.cancelled_by
      WHERE t.id = $1
    `, [id])

    if (!task)          return NextResponse.json({ error: 'Tarea no encontrada' }, { status: 404 })
    // Tareas eliminadas solo visibles para admin
    if (task.deleted_at && !isAdmin)
      return NextResponse.json({ error: 'Tarea no encontrada' }, { status: 404 })

    // Operators solo pueden ver sus propias tareas
    if (!isAdmin) {
      const [assigned] = await query<{ task_id: string }>(
        `SELECT task_id FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
        [id, user.user_id]
      )
      if (!assigned) return NextResponse.json({ error: 'No tienes acceso a esta tarea' }, { status: 403 })
    }

    const logs = await query<{
      id: string; user_name: string | null; action: string
      from_status: string | null; to_status: string | null; comment: string | null; created_at: string
    }>(
      `SELECT id, user_name, action, from_status, to_status, comment, created_at
       FROM task_logs WHERE task_id = $1 ORDER BY created_at ASC`,
      [id]
    )

    return NextResponse.json({
      task: {
        ...task,
        assignees: typeof task.assignees_json === 'string'
          ? JSON.parse(task.assignees_json)
          : (task.assignees_json ?? []),
      },
      logs,
    })
  } catch (e) {
    console.error('[GET /api/tasks/[id]]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error al obtener la tarea' }, { status: 500 })
  }
}

// ── PUT /api/tasks/[id] — Editar tarea (solo admin) ──────────────────────────

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const auth = await checkPermissionWithUser(req, 'tasks', 'update')
  if (!auth.ok) return auth.response
  const { user } = auth

  if (user.role !== 'admin')
    return NextResponse.json({ error: 'Solo los administradores pueden editar tareas' }, { status: 403 })

  let body: {
    title?: string; description?: string; type?: string; priority?: string
    assignees?: string[]; due_date?: string | null; scheduled_at?: string | null
    related_data?: Record<string, unknown>; notes?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido en el cuerpo de la solicitud' }, { status: 400 })
  }

  try {
    const [existing] = await query<{ id: string; status: string; type: string; deleted_at: string | null }>(
      `SELECT id, status, type, deleted_at FROM tasks WHERE id = $1`,
      [id]
    )
    if (!existing)
      return NextResponse.json({ error: 'Tarea no encontrada' }, { status: 404 })
    if (existing.deleted_at)
      return NextResponse.json({ error: 'No se puede editar una tarea eliminada' }, { status: 400 })
    if (existing.status === 'cancelada')
      return NextResponse.json({ error: 'No se puede editar una tarea cancelada' }, { status: 400 })
    if (existing.status === 'completada')
      return NextResponse.json({ error: 'No se puede editar una tarea completada' }, { status: 400 })

    // Determinar el tipo final (puede haber cambiado en el body)
    const finalType = (body.type || existing.type) as TaskType

    // Validar related_data si se envió o si cambió el tipo
    if (body.related_data !== undefined || body.type !== undefined) {
      const rdToValidate = body.related_data ?? {}
      const rdValidation = validateRelatedData(finalType, rdToValidate)
      if (!rdValidation.ok)
        return NextResponse.json({ error: rdValidation.error }, { status: 400 })
    }

    const updates: string[] = ['updated_at = NOW()']
    const values: unknown[] = []
    let pIdx = 1

    if (body.title !== undefined) {
      const t = clampStr(body.title, 500)
      if (!t) return NextResponse.json({ error: 'El título no puede estar vacío' }, { status: 400 })
      updates.push(`title = $${pIdx++}`); values.push(t)
    }
    if (body.description !== undefined) {
      updates.push(`description = $${pIdx++}`)
      values.push(clampStr(body.description, 5000) || null)
    }
    if (body.type !== undefined) {
      if (!TASK_TYPES.includes(body.type as TaskType))
        return NextResponse.json({ error: 'Tipo de tarea inválido' }, { status: 400 })
      updates.push(`type = $${pIdx++}`); values.push(body.type)
    }
    if (body.priority !== undefined) {
      if (!TASK_PRIORITIES.includes(body.priority as TaskPriority))
        return NextResponse.json({ error: 'Prioridad inválida' }, { status: 400 })
      updates.push(`priority = $${pIdx++}`); values.push(body.priority)
    }
    if (body.due_date !== undefined) {
      if (body.due_date === null) {
        updates.push('due_date = NULL')
      } else {
        const d = new Date(body.due_date)
        if (isNaN(d.getTime()))
          return NextResponse.json({ error: 'Formato de fecha límite inválido' }, { status: 400 })
        updates.push(`due_date = $${pIdx++}`); values.push(d.toISOString())
      }
    }
    if (body.scheduled_at !== undefined) {
      if (body.scheduled_at === null) {
        updates.push('scheduled_at = NULL')
      } else {
        const d = new Date(body.scheduled_at)
        if (isNaN(d.getTime()))
          return NextResponse.json({ error: 'Formato de fecha de inicio inválido' }, { status: 400 })
        updates.push(`scheduled_at = $${pIdx++}`); values.push(d.toISOString())
      }
    }
    if (body.notes !== undefined) {
      updates.push(`notes = $${pIdx++}`)
      values.push(clampStr(body.notes, 2000) || null)
    }
    if (body.related_data !== undefined && typeof body.related_data === 'object') {
      const rdValidation = validateRelatedData(finalType, body.related_data)
      if (!rdValidation.ok)
        return NextResponse.json({ error: rdValidation.error }, { status: 400 })
      updates.push(`related_data = $${pIdx++}::jsonb`)
      values.push(JSON.stringify(rdValidation.data))
    }

    values.push(id)

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE tasks SET ${updates.join(', ')} WHERE id = $${pIdx}`,
        values
      )

      if (Array.isArray(body.assignees)) {
        const validIds = body.assignees.filter(
          (a): a is string => typeof a === 'string' && isUUID(a)
        )
        await client.query(`DELETE FROM task_assignees WHERE task_id = $1`, [id])
        for (const uid of validIds) {
          await client.query(
            `INSERT INTO task_assignees (task_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [id, uid]
          )
        }
      }

      await client.query(
        `INSERT INTO task_logs (task_id, user_id, user_name, action)
         VALUES ($1, $2, $3, 'editada')`,
        [id, user.user_id, user.name || user.email]
      )
    })

    void audit({ req, action: 'update', resource: 'tasks', resource_id: id })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[PUT /api/tasks/[id]]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'No se pudo actualizar la tarea. Intenta de nuevo.' }, { status: 500 })
  }
}

// ── DELETE /api/tasks/[id] — Soft delete (solo admin) ────────────────────────

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const auth = await checkPermissionWithUser(req, 'tasks', 'delete')
  if (!auth.ok) return auth.response
  const { user } = auth

  if (user.role !== 'admin')
    return NextResponse.json({ error: 'Solo los administradores pueden eliminar tareas' }, { status: 403 })

  let reason = ''
  try {
    const b = await req.json().catch(() => ({}))
    reason = clampStr(b?.reason, 500) || ''
  } catch { /* sin razón */ }

  try {
    const [task] = await query<{ id: string; status: string; title: string; deleted_at: string | null }>(
      `SELECT id, status, title, deleted_at FROM tasks WHERE id = $1`,
      [id]
    )
    if (!task)
      return NextResponse.json({ error: 'Tarea no encontrada' }, { status: 404 })
    if (task.deleted_at)
      return NextResponse.json({ error: 'La tarea ya fue eliminada' }, { status: 400 })

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE tasks
         SET deleted_at = NOW(), deleted_by = $1, updated_at = NOW()
         WHERE id = $2`,
        [user.user_id, id]
      )
      await client.query(
        `INSERT INTO task_logs (task_id, user_id, user_name, action, from_status, comment)
         VALUES ($1, $2, $3, 'eliminada', $4, $5)`,
        [id, user.user_id, user.name || user.email, task.status, reason || null]
      )
    })

    void audit({ req, action: 'delete', resource: 'tasks', resource_id: id,
      metadata: { reason, title: task.title, previous_status: task.status } })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[DELETE /api/tasks/[id]]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'No se pudo eliminar la tarea. Intenta de nuevo.' }, { status: 500 })
  }
}
