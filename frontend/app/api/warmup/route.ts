import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function GET() {
  try {
    const numbers = await query(`
      SELECT id, phone_number, instance_name, display_name, warmup_status, current_day, target_days,
             messages_sent_today, daily_limit, last_message_at, start_date, notes, timezone
      FROM warmup_numbers
      ORDER BY created_at DESC
    `)
    return NextResponse.json({ numbers })
  } catch (e) {
    console.error('[/api/warmup GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let body: {
    phone_number?: string; instance_name?: string; display_name?: string
    target_days?: number; daily_limit?: number; notes?: string; timezone?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { phone_number, instance_name, display_name, target_days = 14, daily_limit = 10, notes, timezone } = body

  if (!phone_number || !instance_name) {
    return NextResponse.json({ error: 'phone_number e instance_name son requeridos' }, { status: 400 })
  }

  try {
    const rows = await query(`
      INSERT INTO warmup_numbers (phone_number, instance_name, display_name, target_days, daily_limit, notes, timezone)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `, [
      phone_number.trim(),
      instance_name.trim(),
      display_name?.trim() || null,
      target_days,
      daily_limit,
      notes || null,
      timezone || 'America/Argentina/Buenos_Aires',
    ])

    return NextResponse.json({ id: (rows[0] as { id: string }).id })
  } catch (e) {
    console.error('[/api/warmup POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
