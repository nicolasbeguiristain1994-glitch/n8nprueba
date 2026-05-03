import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

// ── GET /api/tasks/my — Tareas asignadas al usuario actual ────────────────────

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'tasks', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth

  const url    = req.nextUrl
  const status = url.searchParams.get('status') || ''
  const q      = url.searchParams.get('q')      || ''
  const page   = Math.max(1, Number(url.searchParams.get('page') || 1))
  const limit  = 50
  const offset = (page - 1) * limit

  try {
    const conditions: string[] = [
      'ta.user_id = $1',
      't.deleted_at IS NULL',   // excluir tareas eliminadas
    ]
    const params: unknown[] = [user.user_id]
    let pIdx = 2

    if (status) { conditions.push(`t.status = $${pIdx++}`);                                                   params.push(status) }
    if (q)      { conditions.push(`(t.title ILIKE $${pIdx} OR t.description ILIKE $${pIdx})`); pIdx++;        params.push(`%${q}%`) }

    const where = `WHERE ${conditions.join(' AND ')}`

    const rows = await query<{
      id: string; title: string; description: string | null; type: string
      priority: string; status: string; due_date: string | null; scheduled_at: string | null
      related_data: Record<string, unknown>; notes: string | null
      created_by_name: string | null; created_at: string
      completed_at: string | null; completion_notes: string | null
      assignees_json: unknown
    }>(`
      SELECT
        t.id, t.title, t.description, t.type, t.priority, t.status,
        t.due_date, t.scheduled_at, t.related_data, t.notes,
        cb.name AS created_by_name, t.created_at,
        t.completed_at, t.completion_notes,
        COALESCE(
          (SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'email', u.email))
           FROM task_assignees ta2 JOIN users u ON u.id = ta2.user_id
           WHERE ta2.task_id = t.id),
          '[]'::json
        ) AS assignees_json
      FROM task_assignees ta
      JOIN tasks t ON t.id = ta.task_id
      LEFT JOIN users cb ON cb.id = t.created_by
      ${where}
      ORDER BY
        CASE t.status
          WHEN 'en_progreso' THEN 1
          WHEN 'pendiente'   THEN 2
          WHEN 'completada'  THEN 3
          WHEN 'cancelada'   THEN 4
        END,
        CASE t.priority WHEN 'alta' THEN 1 WHEN 'media' THEN 2 WHEN 'baja' THEN 3 END,
        t.due_date ASC NULLS LAST,
        t.created_at DESC
      LIMIT $${pIdx++} OFFSET $${pIdx++}
    `, [...params, limit, offset])

    const [countRow] = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
       ${where}`,
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
    console.error('[GET /api/tasks/my]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error al cargar tus tareas' }, { status: 500 })
  }
}
