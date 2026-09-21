import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'

// GET /api/encuestas/[id]/respuestas?from=...&to=...&campaign=...&username=...&limit=...&offset=...
//
// Filtros opcionales:
//   from      → ISO date, inclusivo
//   to        → ISO date, exclusivo
//   campaign  → exact match
//   username  → busca parcial ILIKE (%username%)
//   limit     → default 100, max 500
//   offset    → default 0
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
  const limit    = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100))
  const offset   = Math.max(0, Number(url.searchParams.get('offset')) || 0)

  const where: string[] = ['r.encuesta_id = $1']
  const vals: unknown[] = [id]
  let i = 2

  if (from && !Number.isNaN(Date.parse(from)))  { where.push(`r.submitted_at >= $${i++}`); vals.push(from) }
  if (to   && !Number.isNaN(Date.parse(to)))    { where.push(`r.submitted_at < $${i++}`);  vals.push(to) }
  if (campaign && /^[a-zA-Z0-9_.-]{1,60}$/.test(campaign)) {
    where.push(`r.campaign = $${i++}`); vals.push(campaign)
  }
  if (username && /^[a-zA-Z0-9._-]{1,60}$/.test(username)) {
    // Búsqueda parcial case-insensitive — pensada para el buscador del admin.
    where.push(`r.username ILIKE $${i++}`); vals.push(`%${username}%`)
  }

  const whereSql = 'WHERE ' + where.join(' AND ')

  const [{ count }] = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM encuesta_respuestas r ${whereSql}`,
    vals,
  )

  vals.push(limit, offset)
  const rows = await query<{
    id: string; answers: Record<string, unknown>
    username: string; email: string | null
    campaign: string | null; source: string | null; player_token: string | null
    submitted_at: string
  }>(
    `SELECT id, answers, username, email, campaign, source, player_token, submitted_at
       FROM encuesta_respuestas r
     ${whereSql}
     ORDER BY r.submitted_at DESC
     LIMIT $${i++} OFFSET $${i++}`,
    vals,
  )

  return NextResponse.json({ respuestas: rows, total: count, limit, offset })
}
