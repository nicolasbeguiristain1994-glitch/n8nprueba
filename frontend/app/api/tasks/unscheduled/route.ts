import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import { TASK_TYPES, TASK_PRIORITIES, type TaskType, type TaskPriority } from '@/lib/task-types'

// ── GET /api/tasks/unscheduled — Tareas activas sin fecha programada ──────────
//
// Query params:
//   type        — filtro tipo de tarea
//   priority    — filtro prioridad
//   operator    — UUID usuario (solo admin)
//
// Solo devuelve tareas pendientes o en_progreso (sin completada/cancelada).
// Admin ve todas; operador solo sus tareas asignadas.

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'tasks', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth
  const isAdmin = user.role === 'admin'

  const url      = req.nextUrl
  const type     = url.searchParams.get('type')     || ''
  const priority = url.searchParams.get('priority') || ''
  const operator = url.searchParams.get('operator') || ''

  if (type     && !TASK_TYPES.includes(type as TaskType))
    return NextResponse.json({ error: 'type inválido' }, { status: 400 })
  if (priority && !TASK_PRIORITIES.includes(priority as TaskPriority))
    return NextResponse.json({ error: 'priority inválido' }, { status: 400 })
  if (operator && !isUUID(operator))
    return NextResponse.json({ error: 'operator debe ser UUID' }, { status: 400 })

  try {
    const conditions: string[] = [
      't.deleted_at IS NULL',
      't.due_date IS NULL',
      't.scheduled_at IS NULL',
      `t.status NOT IN ('completada', 'cancelada')`,
    ]
    const params: unknown[] = []
    let pIdx = 1

    if (type)     { conditions.push(`t.type = $${pIdx++}`)    ; params.push(type) }
    if (priority) { conditions.push(`t.priority = $${pIdx++}`); params.push(priority) }

    if (!isAdmin) {
      conditions.push(
        `EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $${pIdx++})`
      )
      params.push(user.user_id)
    } else if (operator) {
      conditions.push(
        `EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $${pIdx++})`
      )
      params.push(operator)
    }

    const where = `WHERE ${conditions.join(' AND ')}`

    type Row = {
      id: string; title: string; type: string; priority: string; status: string
      assignees_json: unknown
    }

    const rows = await query<Row>(`
      SELECT
        t.id, t.title, t.type, t.priority, t.status,
        COALESCE(
          (SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'email', u.email))
           FROM task_assignees ta JOIN users u ON u.id = ta.user_id
           WHERE ta.task_id = t.id),
          '[]'::json
        ) AS assignees_json
      FROM tasks t
      ${where}
      ORDER BY
        CASE t.priority WHEN 'alta' THEN 1 WHEN 'media' THEN 2 WHEN 'baja' THEN 3 END,
        t.created_at DESC
      LIMIT 100
    `, params)

    const tasks = rows.map(r => ({
      ...r,
      assignees: typeof r.assignees_json === 'string'
        ? JSON.parse(r.assignees_json)
        : (r.assignees_json ?? []),
    }))

    return NextResponse.json({ tasks, total: tasks.length })
  } catch (e) {
    console.error('[GET /api/tasks/unscheduled]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
