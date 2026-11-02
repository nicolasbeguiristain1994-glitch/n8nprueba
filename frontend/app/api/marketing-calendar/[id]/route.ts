// frontend/app/api/marketing-calendar/[id]/route.ts

import { agentScope, canAccessAgent, AGENT_KEYS } from '@/lib/agent-scope'
import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { validDateRange } from '@/lib/dashboard-format'
import { isUUID } from '@/lib/validate'
import { query }                     from '@/lib/db'

// ── PUT /api/marketing-calendar/[id] ─────────────────────────────────────────

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'calendar', 'update')
  if (!auth.ok) return auth.response
  const session = auth.user

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
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
    const existing = await query<{ created_by: string; agent_key: string | null }>(
      'SELECT created_by, agent_key FROM marketing_calendar WHERE id = $1',
      [id],
    )
    if (existing.length === 0 || !canAccessAgent(session, existing[0].agent_key)) {
      return NextResponse.json({ error: 'No encontrado' }, { status: 404 })
    }
    if (session.role !== 'admin' && existing[0].created_by !== session.user_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const rows = await query(
      `UPDATE marketing_calendar
       SET date = $1, hour = $2, title = $3, consigna = $4,
           image_url = $5, agent_key=$7, updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [
        date,
        hour !== undefined && hour !== null ? Number(hour) : null,
        title.trim(),
        consigna?.trim() || null,
        image_url || null,
        id, agent,
      ],
    )
    return NextResponse.json({ entry: rows[0] })
  } catch (err) {
    console.error('[marketing-calendar PUT]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

// ── DELETE /api/marketing-calendar/[id] ──────────────────────────────────────

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'calendar', 'delete')
  if (!auth.ok) return auth.response
  const session = auth.user

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  try {
    const existing = await query<{ created_by: string; agent_key: string | null }>(
      'SELECT created_by, agent_key FROM marketing_calendar WHERE id = $1',
      [id],
    )
    if (existing.length === 0 || !canAccessAgent(session, existing[0].agent_key)) {
      return NextResponse.json({ error: 'No encontrado' }, { status: 404 })
    }
    if (session.role !== 'admin' && existing[0].created_by !== session.user_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    await query('DELETE FROM marketing_calendar WHERE id = $1', [id])
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[marketing-calendar DELETE]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
