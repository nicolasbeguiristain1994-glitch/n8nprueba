// frontend/app/api/marketing-calendar/route.ts

import { agentScope, canAccessAgent, AGENT_KEYS } from '@/lib/agent-scope'
import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { validDateRange } from '@/lib/dashboard-format'
import { isUUID } from '@/lib/validate'
import { query }                     from '@/lib/db'

// ── GET /api/marketing-calendar?start=YYYY-MM-DD&end=YYYY-MM-DD ──────────────

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'calendar', 'read')
  if (!auth.ok) return auth.response
  const session = auth.user

  const { searchParams } = new URL(req.url)
  const start = searchParams.get('start')
  const end   = searchParams.get('end')

  if (!start || !end || !validDateRange(start, end)) {
    return NextResponse.json({ error: 'start y end son requeridos' }, { status: 400 })
  }

  try {
    const entries = await query(
      `SELECT
         mc.id, mc.date, mc.hour, mc.title, mc.consigna, mc.image_url,
         mc.created_by, mc.created_at, mc.agent_key,
         u.name AS creator_name
       FROM marketing_calendar mc
       LEFT JOIN users u ON mc.created_by = u.id
       WHERE mc.date >= $1::date
         AND mc.date <= $2::date
         AND ($3::text[] IS NULL OR mc.agent_key=ANY($3))
       ORDER BY mc.date, mc.hour NULLS LAST, mc.created_at`,
      [start, end, agentScope(session)],
    )
    return NextResponse.json({ entries })
  } catch (err) {
    console.error('[marketing-calendar GET]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

// ── POST /api/marketing-calendar ─────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'calendar', 'create')
  if (!auth.ok) return auth.response
  const session = auth.user

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 })
  const { date, hour, title, consigna, image_url } = body
  const agents = agentScope(session)
  const agent = body.agent_key ?? (agents?.length === 1 ? agents[0] : null)
  if (agent !== null && !AGENT_KEYS.includes(agent)) return NextResponse.json({ error: 'Agente inválido' }, { status: 400 })
  if (!canAccessAgent(session, agent)) return NextResponse.json({ error: 'Seleccioná un agente permitido' }, { status: 403 })

  if ((consigna != null && typeof consigna !== 'string') || (image_url != null && typeof image_url !== 'string') || typeof date !== 'string' || !validDateRange(date, date) || typeof title !== 'string' || !title.trim() || title.length > 500
    || (hour != null && (!Number.isInteger(Number(hour)) || Number(hour) < 0 || Number(hour) > 23))) {
    return NextResponse.json({ error: 'date y title son requeridos' }, { status: 400 })
  }

  try {
    const rows = await query(
      `INSERT INTO marketing_calendar (date, hour, title, consigna, image_url, created_by, agent_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        date,
        hour !== undefined && hour !== null ? Number(hour) : null,
        title.trim(),
        consigna?.trim() || null,
        image_url || null,
        session.user_id, agent,
      ],
    )
    return NextResponse.json({ entry: rows[0] }, { status: 201 })
  } catch (err) {
    console.error('[marketing-calendar POST]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
