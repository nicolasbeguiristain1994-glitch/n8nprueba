// frontend/app/api/marketing-calendar/[id]/route.ts

import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest }     from '@/lib/auth'
import { query }                     from '@/lib/db'

// ── PUT /api/marketing-calendar/[id] ─────────────────────────────────────────

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = getSessionFromRequest(req)
  if (!session)                  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (session.role === 'viewer') return NextResponse.json({ error: 'Forbidden' },    { status: 403 })

  const { id } = await params
  const body   = await req.json()
  const { date, hour, title, consigna, image_url } = body

  if (!date || !title?.trim()) {
    return NextResponse.json({ error: 'date y title son requeridos' }, { status: 400 })
  }

  try {
    const existing = await query<{ created_by: string }>(
      'SELECT created_by FROM marketing_calendar WHERE id = $1',
      [id],
    )
    if (existing.length === 0) {
      return NextResponse.json({ error: 'No encontrado' }, { status: 404 })
    }
    if (session.role !== 'admin' && existing[0].created_by !== session.user_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const rows = await query(
      `UPDATE marketing_calendar
       SET date = $1, hour = $2, title = $3, consigna = $4,
           image_url = $5, updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [
        date,
        hour !== undefined && hour !== null ? Number(hour) : null,
        title.trim(),
        consigna?.trim() || null,
        image_url || null,
        id,
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
  const session = getSessionFromRequest(req)
  if (!session)                  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (session.role === 'viewer') return NextResponse.json({ error: 'Forbidden' },    { status: 403 })

  const { id } = await params

  try {
    const existing = await query<{ created_by: string }>(
      'SELECT created_by FROM marketing_calendar WHERE id = $1',
      [id],
    )
    if (existing.length === 0) {
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
