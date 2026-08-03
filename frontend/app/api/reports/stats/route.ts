import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

// GET /api/reports/stats?period=week|month
export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'read')
  if (!auth.ok) return auth.response

  const sp     = req.nextUrl.searchParams
  const period = sp.get('period') || 'month'

  let curr: string
  let prev: string

  if (period === 'week') {
    curr = `fecha >= CURRENT_DATE - INTERVAL '6 days'`
    prev = `fecha >= CURRENT_DATE - INTERVAL '13 days' AND fecha < CURRENT_DATE - INTERVAL '6 days'`
  } else {
    curr = `fecha >= DATE_TRUNC('month', CURRENT_DATE)`
    prev = `fecha >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
            AND fecha < DATE_TRUNC('month', CURRENT_DATE)`
  }

  try {
    const [summary, prevSummary, byDay, byBase, byOficina, byLinea] = await Promise.all([
      query<Record<string, string>>(
        `SELECT
           SUM(enviados)::int             AS total_enviados,
           SUM(COALESCE(respuestas, 0))::int AS total_respuestas,
           SUM(COALESCE(cargas, 0))::int  AS total_cargas
         FROM sending_reports WHERE ${curr}`,
        [],
      ),
      query<Record<string, string>>(
        `SELECT
           SUM(enviados)::int             AS total_enviados,
           SUM(COALESCE(respuestas, 0))::int AS total_respuestas
         FROM sending_reports WHERE ${prev}`,
        [],
      ),
      query<Record<string, unknown>>(
        `SELECT
           fecha::text,
           SUM(enviados)::int                  AS enviados,
           SUM(COALESCE(respuestas, 0))::int   AS respuestas,
           SUM(COALESCE(cargas, 0))::int       AS cargas
         FROM sending_reports WHERE ${curr}
         GROUP BY fecha ORDER BY fecha`,
        [],
      ),
      query<Record<string, unknown>>(
        `SELECT
           base_datos,
           SUM(enviados)::int                  AS enviados,
           SUM(COALESCE(respuestas, 0))::int   AS respuestas
         FROM sending_reports WHERE ${curr}
         GROUP BY base_datos ORDER BY enviados DESC LIMIT 12`,
        [],
      ),
      query<Record<string, unknown>>(
        `SELECT
           oficina,
           SUM(enviados)::int                  AS enviados,
           SUM(COALESCE(respuestas, 0))::int   AS respuestas,
           SUM(COALESCE(cargas, 0))::int       AS cargas
         FROM sending_reports WHERE ${curr}
         GROUP BY oficina ORDER BY enviados DESC`,
        [],
      ),
      query<Record<string, unknown>>(
        `SELECT
           linea,
           SUM(enviados)::int                  AS enviados,
           SUM(COALESCE(respuestas, 0))::int   AS respuestas
         FROM sending_reports WHERE ${curr}
         GROUP BY linea ORDER BY enviados DESC`,
        [],
      ),
    ])

    const s = summary[0] ?? {}
    const p = prevSummary[0] ?? {}

    return NextResponse.json({
      summary: {
        total_enviados:    Number(s.total_enviados    ?? 0),
        total_respuestas:  Number(s.total_respuestas  ?? 0),
        total_cargas:      Number(s.total_cargas      ?? 0),
        prev_enviados:     Number(p.total_enviados    ?? 0),
        prev_respuestas:   Number(p.total_respuestas  ?? 0),
      },
      by_day:     byDay,
      by_base:    byBase,
      by_oficina: byOficina,
      by_linea:   byLinea,
    })
  } catch (e) {
    console.error('[/api/reports/stats GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
