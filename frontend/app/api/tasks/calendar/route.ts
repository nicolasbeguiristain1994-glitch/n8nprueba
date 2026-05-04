import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import { TASK_TYPES, TASK_PRIORITIES, type TaskType, type TaskPriority } from '@/lib/task-types'

// ── GET /api/tasks/calendar — Tareas en rango de fechas ───────────────────────
//
// Query params:
//   start       — ISO timestamp inicio (obligatorio)
//   end         — ISO timestamp fin    (obligatorio)
//   type        — filtro tipo de tarea
//   priority    — filtro prioridad
//   operator    — UUID usuario (solo admin)
//
// Devuelve tareas cuya `due_date` O `scheduled_at` cae dentro del rango.
// Admin ve todas; operador solo sus tareas asignadas.

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'tasks', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth
  const isAdmin = user.role === 'admin'

  const url      = req.nextUrl
  const start    = url.searchParams.get('start')    || ''
  const end      = url.searchParams.get('end')      || ''
  const type     = url.searchParams.get('type')     || ''
  const priority = url.searchParams.get('priority') || ''
  const operator = url.searchParams.get('operator') || ''  // admin only

  if (!start || !end)
    return NextResponse.json({ error: 'Los parámetros start y end son obligatorios' }, { status: 400 })

  const startDate = new Date(start)
  const endDate   = new Date(end)
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()))
    return NextResponse.json({ error: 'Formato de fecha inválido' }, { status: 400 })

  if (type     && !TASK_TYPES.includes(type as TaskType))
    return NextResponse.json({ error: 'type inválido' }, { status: 400 })
  if (priority && !TASK_PRIORITIES.includes(priority as TaskPriority))
    return NextResponse.json({ error: 'priority inválido' }, { status: 400 })
  if (operator && !isUUID(operator))
    return NextResponse.json({ error: 'operator debe ser UUID' }, { status: 400 })

  try {
    const conditions: string[] = [
      't.deleted_at IS NULL',
      `(t.due_date BETWEEN $1 AND $2 OR t.scheduled_at BETWEEN $1 AND $2)`,
    ]
    const params: unknown[] = [startDate.toISOString(), endDate.toISOString()]
    let pIdx = 3

    if (type)     { conditions.push(`t.type = $${pIdx++}`)    ; params.push(type) }
    if (priority) { conditions.push(`t.priority = $${pIdx++}`); params.push(priority) }

    if (!isAdmin) {
      // Operadores solo ven sus tareas
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

    type CalTaskRow = {
      id: string; title: string; type: string; priority: string; status: string
      due_date: string | null; scheduled_at: string | null
      assignees_json: unknown
    }

    const rows = await query<CalTaskRow>(`
      SELECT
        t.id, t.title, t.type, t.priority, t.status,
        t.due_date, t.scheduled_at,
        COALESCE(
          (SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'email', u.email))
           FROM task_assignees ta JOIN users u ON u.id = ta.user_id
           WHERE ta.task_id = t.id),
          '[]'::json
        ) AS assignees_json
      FROM tasks t
      ${where}
      ORDER BY t.due_date ASC NULLS LAST, t.scheduled_at ASC NULLS LAST
    `, params)

    const tasks = rows.map(r => ({
      ...r,
      assignees: typeof r.assignees_json === 'string'
        ? JSON.parse(r.assignees_json)
        : (r.assignees_json ?? []),
    }))

    return NextResponse.json({ tasks })
  } catch (e) {
    console.error('[GET /api/tasks/calendar]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
