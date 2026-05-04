import { NextRequest, NextResponse } from 'next/server'
import { query, withTransaction } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { isUUID, clampStr } from '@/lib/validate'
import {
  TASK_TYPES, TASK_PRIORITIES, TASK_STATUSES,
  type TaskType, type TaskPriority, type TaskStatus,
  validateRelatedData,
} from '@/lib/task-types'
import { notifyMany } from '@/lib/notify'

// ── GET /api/tasks — Listar todas las tareas (admin) ──────────────────────────

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'tasks', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth

  if (user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const url             = req.nextUrl
  const status          = url.searchParams.get('status')           || ''
  const type            = url.searchParams.get('type')             || ''
  const priority        = url.searchParams.get('priority')         || ''
  const operator        = url.searchParams.get('operator')         || ''
  const q               = url.searchParams.get('q')                || ''
  const includeDeleted  = url.searchParams.get('include_deleted')  === 'true'
  const page            = Math.max(1, Number(url.searchParams.get('page') || 1))
  const limit           = 50
  const offset          = (page - 1) * limit

  if (status   && !TASK_STATUSES.includes(status as TaskStatus))
    return NextResponse.json({ error: 'status inválido' }, { status: 400 })
  if (type     && !TASK_TYPES.includes(type as TaskType))
    return NextResponse.json({ error: 'type inválido' }, { status: 400 })
  if (priority && !TASK_PRIORITIES.includes(priority as TaskPriority))
    return NextResponse.json({ error: 'priority inválido' }, { status: 400 })
  if (operator && !isUUID(operator))
    return NextResponse.json({ error: 'operator debe ser UUID' }, { status: 400 })

  try {
    const conditions: string[] = []
    const params: unknown[]    = []
    let pIdx = 1

    // Soft delete: por defecto ocultar eliminadas
    if (!includeDeleted) conditions.push('t.deleted_at IS NULL')

    if (status)   { conditions.push(`t.status = $${pIdx++}`)    ; params.push(status) }
    if (type)     { conditions.push(`t.type = $${pIdx++}`)      ; params.push(type) }
    if (priority) { conditions.push(`t.priority = $${pIdx++}`)  ; params.push(priority) }
    if (q)        { conditions.push(`(t.title ILIKE $${pIdx} OR t.description ILIKE $${pIdx})`); pIdx++; params.push(`%${q}%`) }
    if (operator) {
      conditions.push(
        `EXISTS (SELECT 1 FROM task_assignees ta2 WHERE ta2.task_id = t.id AND ta2.user_id = $${pIdx++})`
      )
      params.push(operator)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    type TaskRowRaw = {
      id: string; title: string; description: string | null; type: string
      priority: string; status: string; due_date: string | null; scheduled_at: string | null
      related_data: Record<string, unknown>; notes: string | null
      created_by: string | null; created_by_name: string | null
      created_at: string; updated_at: string
      completed_at: string | null; completed_by: string | null
      completed_by_name: string | null; completion_notes: string | null
      cancelled_at: string | null; cancelled_by: string | null
      cancelled_by_name: string | null; cancel_reason: string | null
      deleted_at: string | null; deleted_by: string | null
      assignees_json: unknown
    }

    const rows = await query<TaskRowRaw>(`
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
      ${where}
      ORDER BY
        CASE t.priority WHEN 'alta' THEN 1 WHEN 'media' THEN 2 WHEN 'baja' THEN 3 END,
        t.created_at DESC
      LIMIT $${pIdx++} OFFSET $${pIdx++}
    `, [...params, limit, offset])

    const [countRow] = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tasks t ${where}`,
      params
    )

    const tasks = rows.map(r => ({
      ...r,
      assignees: typeof r.assignees_json === 'string'
        ? JSON.parse(r.assignees_json)
        : (r.assignees_json ?? []),
    }))

    return NextResponse.json({ tasks, total: Number(countRow?.count ?? 0), page, limit })
  } catch (e) {
    console.error('[GET /api/tasks]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}

// ── POST /api/tasks — Crear tarea (solo admin) ────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'tasks', 'create')
  if (!auth.ok) return auth.response
  const { user } = auth

  if (user.role !== 'admin') {
    return NextResponse.json({ error: 'Solo los administradores pueden crear tareas' }, { status: 403 })
  }

  let body: {
    title?: string; description?: string; type?: string; priority?: string
    assignees?: string[]; due_date?: string; scheduled_at?: string
    related_data?: Record<string, unknown>; notes?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido en el cuerpo de la solicitud' }, { status: 400 })
  }

  const title = clampStr(body.title, 500)
  if (!title)
    return NextResponse.json({ error: 'El título es obligatorio y no puede estar vacío' }, { status: 400 })

  const type     = (body.type     || 'otro') as TaskType
  const priority = (body.priority || 'media') as TaskPriority

  if (!TASK_TYPES.includes(type))
    return NextResponse.json({ error: `Tipo de tarea inválido. Opciones: ${TASK_TYPES.join(', ')}` }, { status: 400 })
  if (!TASK_PRIORITIES.includes(priority))
    return NextResponse.json({ error: `Prioridad inválida. Opciones: ${TASK_PRIORITIES.join(', ')}` }, { status: 400 })

  // Validar related_data con Zod
  const rdValidation = validateRelatedData(type, body.related_data ?? {})
  if (!rdValidation.ok)
    return NextResponse.json({ error: rdValidation.error }, { status: 400 })

  const assignees: string[] = Array.isArray(body.assignees)
    ? body.assignees.filter((a): a is string => typeof a === 'string' && isUUID(a))
    : []

  let dueDate: string | null = null
  if (body.due_date) {
    const d = new Date(body.due_date)
    if (isNaN(d.getTime()))
      return NextResponse.json({ error: 'La fecha límite (due_date) tiene un formato inválido' }, { status: 400 })
    dueDate = d.toISOString()
  }

  let scheduledAt: string | null = null
  if (body.scheduled_at) {
    const d = new Date(body.scheduled_at)
    if (isNaN(d.getTime()))
      return NextResponse.json({ error: 'La fecha de inicio programado (scheduled_at) tiene un formato inválido' }, { status: 400 })
    scheduledAt = d.toISOString()
  }

  try {
    const taskId = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO tasks
           (title, description, type, priority, status, due_date, scheduled_at, related_data, notes, created_by)
         VALUES ($1, $2, $3, $4, 'pendiente', $5, $6, $7::jsonb, $8, $9)
         RETURNING id`,
        [
          title,
          clampStr(body.description, 5000) || null,
          type,
          priority,
          dueDate,
          scheduledAt,
          JSON.stringify(rdValidation.data),
          clampStr(body.notes, 2000) || null,
          user.user_id,
        ]
      )
      const id: string = result.rows[0].id

      for (const userId of assignees) {
        await client.query(
          `INSERT INTO task_assignees (task_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, userId]
        )
      }

      await client.query(
        `INSERT INTO task_logs (task_id, user_id, user_name, action, to_status)
         VALUES ($1, $2, $3, 'creada', 'pendiente')`,
        [id, user.user_id, user.name || user.email]
      )

      return id
    })

    void audit({ req, action: 'create', resource: 'tasks', resource_id: taskId,
      metadata: { title, type, priority, assignees_count: assignees.length } })

    // Notificar a los operadores asignados
    if (assignees.length > 0) {
      void notifyMany(assignees, {
        type:        'tarea_asignada',
        title:       `Tarea asignada: ${title}`,
        body:        `Prioridad ${priority}${dueDate ? ` · Vence ${new Date(dueDate).toLocaleDateString('es-AR')}` : ''}`,
        link:        '/mis-tareas',
        relatedType: 'task',
        relatedId:   taskId,
      })
    }

    return NextResponse.json({ id: taskId }, { status: 201 })
  } catch (e) {
    console.error('[POST /api/tasks]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'No se pudo crear la tarea. Intenta de nuevo.' }, { status: 500 })
  }
}
