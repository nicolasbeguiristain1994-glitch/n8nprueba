// frontend/app/api/marketing-calendar/route.ts

import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest }     from '@/lib/auth'
import { query }                     from '@/lib/db'

// ── GET /api/marketing-calendar?start=YYYY-MM-DD&end=YYYY-MM-DD ──────────────

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const start = searchParams.get('start')
  const end   = searchParams.get('end')

  if (!start || !end) {
    return NextResponse.json({ error: 'start y end son requeridos' }, { status: 400 })
  }

  try {
    const entries = await query(
      `SELECT
         mc.id, mc.date, mc.hour, mc.title, mc.consigna, mc.image_url,
         mc.created_by, mc.created_at,
         u.name AS creator_name
       FROM marketing_calendar mc
       LEFT JOIN users u ON mc.created_by = u.id
       WHERE mc.date >= $1::date
         AND mc.date <= $2::date
       ORDER BY mc.date, mc.hour NULLS LAST, mc.created_at`,
      [start, end],
    )
    return NextResponse.json({ entries })
  } catch (err) {
    console.error('[marketing-calendar GET]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

// ── POST /api/marketing-calendar ─────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session)                  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (session.role === 'viewer') return NextResponse.json({ error: 'Forbidden' },    { status: 403 })

  const body = await req.json()
  const { date, hour, title, consigna, image_url } = body

  if (!date || !title?.trim()) {
    return NextResponse.json({ error: 'date y title son requeridos' }, { status: 400 })
  }

  try {
    const rows = await query(
      `INSERT INTO marketing_calendar (date, hour, title, consigna, image_url, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        date,
        hour !== undefined && hour !== null ? Number(hour) : null,
        title.trim(),
        consigna?.trim() || null,
        image_url || null,
        session.user_id,
      ],
    )
    return NextResponse.json({ entry: rows[0] }, { status: 201 })
  } catch (err) {
    console.error('[marketing-calendar POST]', err)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
