import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkAuth } from '@/lib/permissions'

export async function GET(req: Request) {
  const authErr = checkAuth(req)
  if (authErr) return authErr

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
    console.error('[/api/lines GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
