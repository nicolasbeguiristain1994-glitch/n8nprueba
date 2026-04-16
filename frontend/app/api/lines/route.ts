import { NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function GET() {
  try {
    const lines = await query(`
      SELECT id, line_key, display_name, phone_number, evolution_instance,
             status, is_connected, msgs_sent_today, msgs_sent_hour,
             msg_per_day, msg_per_hour, total_sent, total_failed,
             priority, last_seen_at
      FROM whatsapp_lines
      ORDER BY priority ASC
    `)
    return NextResponse.json({ lines })
  } catch (e) {
    console.error('[/api/lines]', e)
    return NextResponse.json({ lines: [], error: String(e) }, { status: 500 })
  }
}
