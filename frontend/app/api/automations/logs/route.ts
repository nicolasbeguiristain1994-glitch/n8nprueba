import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

type LogRow = {
  id: string
  automation_id: string | null
  automation_name: string | null
  conversation_phone: string
  message_id: string | null
  result: string
  details: string | null
  created_at: string
}

// ── GET /api/automations/logs ─────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'automations' as never, 'read')
  if (!auth.ok) return auth.response

  const { searchParams } = new URL(req.url)
  const automationId = searchParams.get('automation_id') ?? ''
  const result       = searchParams.get('result') ?? ''
  const page         = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
  const limit        = 50

  const conditions: string[] = []
  const params: unknown[] = []
  let p = 0

  if (automationId) {
    conditions.push(`l.automation_id = $${++p}`)
    params.push(automationId)
  }
  if (result && ['executed', 'skipped', 'error'].includes(result)) {
    conditions.push(`l.result = $${++p}`)
    params.push(result)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  try {
    const [rows, countRows] = await Promise.all([
      query<LogRow>(
        `SELECT l.id, l.automation_id, l.automation_name, l.conversation_phone,
                l.message_id, l.result, l.details, l.created_at
         FROM automation_logs l
         ${where}
         ORDER BY l.created_at DESC
         LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        params,
      ),
      query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM automation_logs l ${where}`,
        params,
      ),
    ])

    return NextResponse.json({
      logs: rows,
      total: countRows[0]?.count ?? 0,
      page,
      limit,
    })
  } catch (e) {
    console.error('[/api/automations/logs GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
