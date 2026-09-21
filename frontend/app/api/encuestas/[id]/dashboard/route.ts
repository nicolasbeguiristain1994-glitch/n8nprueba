import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import type { Question } from '@/lib/encuestas'

// GET /api/encuestas/[id]/dashboard?from=...&to=...&campaign=...&username=...
//
// Devuelve KPIs y distribuciones agregadas sobre `answers`. Toda la agregación
// se hace en Postgres — el server sólo compone el JSON de respuesta.
//
// Convenciones:
//   - NPS: pregunta con id 'nps' (rating 0-10). Detractor 0-6, Pasivo 7-8, Promotor 9-10.
//   - Satisfacción global: promedio simple de 'facilidad', 'cashflow' y 'soporte'.
//   - Multiselects: expandimos con jsonb_array_elements_text.
//   - Selects/edad: GROUP BY answers->>'<id>'.

interface Row { count: string | number }

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const auth = await checkPermissionWithUser(req, 'encuestas', 'read')
  if (!auth.ok) return auth.response

  const url = new URL(req.url)
  const from     = url.searchParams.get('from')
  const to       = url.searchParams.get('to')
  const campaign = url.searchParams.get('campaign')
  const username = url.searchParams.get('username')

  // ── Build WHERE clause reutilizable ────────────────────────────────────────
  const where: string[] = ['r.encuesta_id = $1']
  const vals: unknown[] = [id]
  let i = 2
  if (from && !Number.isNaN(Date.parse(from)))  { where.push(`r.submitted_at >= $${i++}`); vals.push(from) }
  if (to   && !Number.isNaN(Date.parse(to)))    { where.push(`r.submitted_at < $${i++}`);  vals.push(to) }
  if (campaign && /^[a-zA-Z0-9_.-]{1,60}$/.test(campaign)) {
    where.push(`r.campaign = $${i++}`); vals.push(campaign)
  }
  if (username && /^[a-zA-Z0-9._-]{3,60}$/.test(username)) {
    where.push(`r.username ILIKE $${i++}`); vals.push(`%${username}%`)
  }
  const W = 'WHERE ' + where.join(' AND ')

  // ── Cargar preguntas activas (para saber qué distribuciones son válidas) ──
  const encRows = await query<{ questions: Question[] }>(
    `SELECT questions FROM encuestas WHERE id = $1 LIMIT 1`,
    [id],
  )
  if (encRows.length === 0) return NextResponse.json({ error: 'No encontrada' }, { status: 404 })
  const questions = encRows[0].questions

  // ── KPIs principales + NPS split (una sola query) ─────────────────────────
  const [kpi] = await query<{
    total: number
    promoters: number; passives: number; detractors: number
    avg_facilidad: string | null
    avg_cashflow:  string | null
    avg_soporte:   string | null
    avg_nps:       string | null
  }>(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE (r.answers->>'nps') ~ '^\\d+$' AND (r.answers->>'nps')::int >= 9)                        ::int AS promoters,
      COUNT(*) FILTER (WHERE (r.answers->>'nps') ~ '^\\d+$' AND (r.answers->>'nps')::int BETWEEN 7 AND 8)             ::int AS passives,
      COUNT(*) FILTER (WHERE (r.answers->>'nps') ~ '^\\d+$' AND (r.answers->>'nps')::int BETWEEN 0 AND 6)             ::int AS detractors,
      AVG(CASE WHEN (r.answers->>'facilidad') ~ '^\\d+$' THEN (r.answers->>'facilidad')::numeric END) AS avg_facilidad,
      AVG(CASE WHEN (r.answers->>'cashflow')  ~ '^\\d+$' THEN (r.answers->>'cashflow')::numeric  END) AS avg_cashflow,
      AVG(CASE WHEN (r.answers->>'soporte')   ~ '^\\d+$' THEN (r.answers->>'soporte')::numeric   END) AS avg_soporte,
      AVG(CASE WHEN (r.answers->>'nps')       ~ '^\\d+$' THEN (r.answers->>'nps')::numeric       END) AS avg_nps
    FROM encuesta_respuestas r
    ${W}
  `, vals)

  // Distribuciones (paralelas). Nota: las queries reutilizan `W` y `vals`.
  const [
    edad,
    juegos,
    bonos,
    motivacion,
    facilidadDist,
    cashflowDist,
    soporteDist,
    npsDist,
  ] = await Promise.all([
    distSelect('edad',       W, vals),
    distMulti ('juegos',     W, vals),
    distMulti ('bonos',      W, vals),
    distMulti ('motivacion', W, vals),
    distRating('facilidad',  W, vals, 1, 10),
    distRating('cashflow',   W, vals, 1, 10),
    distRating('soporte',    W, vals, 1, 10),
    distRating('nps',        W, vals, 0, 10),
  ])

  const totalNps = kpi.promoters + kpi.passives + kpi.detractors
  const nps_score = totalNps === 0
    ? null
    : Math.round(((kpi.promoters - kpi.detractors) / totalNps) * 100)

  const npsPct = totalNps === 0 ? null : {
    promoters:  Math.round((kpi.promoters  / totalNps) * 100),
    passives:   Math.round((kpi.passives   / totalNps) * 100),
    detractors: Math.round((kpi.detractors / totalNps) * 100),
  }

  const avgFac   = numOrNull(kpi.avg_facilidad)
  const avgCash  = numOrNull(kpi.avg_cashflow)
  const avgSop   = numOrNull(kpi.avg_soporte)
  const overall  = averageOf([avgFac, avgCash, avgSop])

  return NextResponse.json({
    filters: { from, to, campaign, username },
    kpis: {
      total_respuestas: kpi.total,
      nps_score,
      nps_pct:          npsPct,
      nps_counts:       { promoters: kpi.promoters, passives: kpi.passives, detractors: kpi.detractors },
      avg_facilidad:    avgFac,
      avg_cashflow:     avgCash,
      avg_soporte:      avgSop,
      avg_nps:          numOrNull(kpi.avg_nps),
      avg_satisfaccion: overall,
    },
    distributions: {
      edad,
      juegos,
      bonos,
      motivacion,
      facilidad: facilidadDist,
      cashflow:  cashflowDist,
      soporte:   soporteDist,
      nps:       npsDist,
    },
    questions_available: questions.map(q => q.id),
  })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function numOrNull(v: string | number | null): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'string' ? Number(v) : v
  if (!Number.isFinite(n)) return null
  return Math.round(n * 10) / 10
}

function averageOf(xs: (number | null)[]): number | null {
  const vals = xs.filter((v): v is number => v !== null)
  if (vals.length === 0) return null
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
}

// Distribución para preguntas 'select' o 'text' cortas (edad, etc.)
async function distSelect(
  qid: string,
  whereSql: string,
  vals: unknown[],
): Promise<{ key: string; count: number }[]> {
  const rows = await query<{ key: string; count: number }>(`
    SELECT (r.answers->>$${vals.length + 1}) AS key, COUNT(*)::int AS count
      FROM encuesta_respuestas r
    ${whereSql}
       AND r.answers ? $${vals.length + 1}
     GROUP BY key
     ORDER BY count DESC
     LIMIT 30
  `, [...vals, qid])
  return rows.filter(r => r.key !== null)
}

// Distribución para 'multiple' — expandimos con jsonb_array_elements_text
async function distMulti(
  qid: string,
  whereSql: string,
  vals: unknown[],
): Promise<{ key: string; count: number }[]> {
  const rows = await query<{ key: string; count: number }>(`
    SELECT elem AS key, COUNT(*)::int AS count
      FROM encuesta_respuestas r,
           LATERAL jsonb_array_elements_text(COALESCE(r.answers -> $${vals.length + 1}, '[]'::jsonb)) AS elem
    ${whereSql}
     GROUP BY elem
     ORDER BY count DESC
     LIMIT 30
  `, [...vals, qid])
  return rows
}

// Distribución para 'rating' — devolvemos histograma [min..max]
async function distRating(
  qid: string,
  whereSql: string,
  vals: unknown[],
  min: number,
  max: number,
): Promise<{ key: string; count: number }[]> {
  const rows = await query<{ key: number; count: number }>(`
    SELECT (r.answers->>$${vals.length + 1})::int AS key, COUNT(*)::int AS count
      FROM encuesta_respuestas r
    ${whereSql}
       AND (r.answers->>$${vals.length + 1}) ~ '^\\d+$'
     GROUP BY key
     ORDER BY key ASC
  `, [...vals, qid])
  const byKey = new Map<number, number>(rows.map(r => [r.key, r.count]))
  const out: { key: string; count: number }[] = []
  for (let n = min; n <= max; n++) out.push({ key: String(n), count: byKey.get(n) ?? 0 })
  return out
}
