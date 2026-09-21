import { NextRequest } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { isUUID } from '@/lib/validate'
import type { Question } from '@/lib/encuestas'

// GET /api/encuestas/[id]/respuestas/export?from=...&to=...&campaign=...
//
// Devuelve un CSV con: submitted_at, campaign, source, player_token, <una columna por pregunta>.
// Sin librerías externas — escape RFC 4180 (comillas dobles).

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = Array.isArray(v)
    ? v.join('; ')
    : typeof v === 'object'
      ? JSON.stringify(v)
      : String(v)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  if (!isUUID(id)) {
    return new Response(JSON.stringify({ error: 'ID inválido' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }

  const auth = await checkPermissionWithUser(req, 'encuestas', 'read')
  if (!auth.ok) return auth.response

  const url = new URL(req.url)
  const from     = url.searchParams.get('from')
  const to       = url.searchParams.get('to')
  const campaign = url.searchParams.get('campaign')
  const username = url.searchParams.get('username')

  // Cargar definición de encuesta (para las columnas por pregunta).
  const encRows = await query<{ slug: string; questions: Question[] }>(
    `SELECT slug, questions FROM encuestas WHERE id = $1 LIMIT 1`,
    [id],
  )
  const enc = encRows[0]
  if (!enc) {
    return new Response(JSON.stringify({ error: 'No encontrada' }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    })
  }

  const where: string[] = ['encuesta_id = $1']
  const vals: unknown[] = [id]
  let i = 2
  if (from && !Number.isNaN(Date.parse(from)))  { where.push(`submitted_at >= $${i++}`); vals.push(from) }
  if (to   && !Number.isNaN(Date.parse(to)))    { where.push(`submitted_at < $${i++}`);  vals.push(to) }
  if (campaign && /^[a-zA-Z0-9_.-]{1,60}$/.test(campaign)) {
    where.push(`campaign = $${i++}`); vals.push(campaign)
  }
  if (username && /^[a-zA-Z0-9._-]{1,60}$/.test(username)) {
    where.push(`username ILIKE $${i++}`); vals.push(`%${username}%`)
  }
  const whereSql = 'WHERE ' + where.join(' AND ')

  const rows = await query<{
    submitted_at: string; username: string; email: string | null
    campaign: string | null; source: string | null
    player_token: string | null; answers: Record<string, unknown>
  }>(
    `SELECT submitted_at, username, email, campaign, source, player_token, answers
       FROM encuesta_respuestas
     ${whereSql}
     ORDER BY submitted_at DESC
     LIMIT 50000`,
    vals,
  )

  // Header. Para preguntas con `allowOther` agregamos también la columna del
  // texto libre `<id>_other`, así el CSV queda plano y filtrable en Excel.
  const header = [
    'submitted_at', 'username', 'email', 'campaign', 'source', 'player_token',
    ...enc.questions.flatMap(q =>
      q.allowOther
        ? [`${q.id}_${q.label}`, `${q.id}_other`]
        : [`${q.id}_${q.label}`],
    ),
  ]

  const lines: string[] = [header.map(csvCell).join(',')]
  for (const r of rows) {
    const line = [
      csvCell(r.submitted_at),
      csvCell(r.username),
      csvCell(r.email),
      csvCell(r.campaign),
      csvCell(r.source),
      csvCell(r.player_token),
      ...enc.questions.flatMap(q =>
        q.allowOther
          ? [csvCell(r.answers?.[q.id]), csvCell(r.answers?.[`${q.id}_other`])]
          : [csvCell(r.answers?.[q.id])],
      ),
    ].join(',')
    lines.push(line)
  }

  const body = '﻿' + lines.join('\r\n')  // BOM para Excel
  const filename = `encuesta-${enc.slug}-${new Date().toISOString().slice(0, 10)}.csv`

  void audit({ req, action: 'export', resource: 'encuestas', resource_id: id, metadata: { rows: rows.length } })

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type':        'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control':       'no-store',
    },
  })
}
