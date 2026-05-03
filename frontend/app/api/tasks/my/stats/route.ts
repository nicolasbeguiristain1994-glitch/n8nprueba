import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

// ── GET /api/tasks/my/stats — KPIs reales del operador (sin paginación) ────────
//
// Respuesta:
//   { pendientes, en_progreso, completadas_hoy, vencidas }
//
// Todos los conteos se calculan sobre la totalidad de tareas activas (no
// eliminadas) del usuario autenticado, independientemente de la paginación.
//
// "completadas_hoy" usa el timezone de Argentina (America/Argentina/Buenos_Aires)
// para que el corte de "hoy" sea medianoche local, no UTC.

const TZ = 'America/Argentina/Buenos_Aires'

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'tasks', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth

  try {
    const [row] = await query<{
      pendientes:       string
      en_progreso:      string
      completadas_hoy:  string
      vencidas:         string
    }>(`
      SELECT
        COUNT(*) FILTER (
          WHERE t.status = 'pendiente'
        )::text                                                           AS pendientes,

        COUNT(*) FILTER (
          WHERE t.status = 'en_progreso'
        )::text                                                           AS en_progreso,

        COUNT(*) FILTER (
          WHERE t.status    = 'completada'
            AND t.completed_at >= DATE_TRUNC('day', NOW() AT TIME ZONE $2) AT TIME ZONE $2
            AND t.completed_at <  DATE_TRUNC('day', NOW() AT TIME ZONE $2) AT TIME ZONE $2
                              +   INTERVAL '1 day'
        )::text                                                           AS completadas_hoy,

        COUNT(*) FILTER (
          WHERE t.due_date < NOW()
            AND t.status NOT IN ('completada', 'cancelada')
        )::text                                                           AS vencidas

      FROM task_assignees ta
      JOIN tasks t ON t.id = ta.task_id
      WHERE ta.user_id    = $1
        AND t.deleted_at IS NULL
    `, [user.user_id, TZ])

    return NextResponse.json({
      pendientes:      Number(row?.pendientes      ?? 0),
      en_progreso:     Number(row?.en_progreso     ?? 0),
      completadas_hoy: Number(row?.completadas_hoy ?? 0),
      vencidas:        Number(row?.vencidas        ?? 0),
    })
  } catch (e) {
    console.error('[GET /api/tasks/my/stats]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error al calcular estadísticas' }, { status: 500 })
  }
}
