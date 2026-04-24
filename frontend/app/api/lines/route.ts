import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'

export async function GET(req: Request) {
  const err = await checkPermission(req, 'lines', 'read')
  if (err) return err

  try {
    const lines = await query(`
      SELECT id, line_key, display_name, phone_number, evolution_instance,
             status, is_connected, sending_enabled,
             msgs_sent_today, msgs_sent_hour,
             msg_per_day, msg_per_hour, total_sent, total_failed,
             priority, last_seen_at,
             (
               status = 'active'
               AND is_connected    = true
               AND sending_enabled = true
               AND msgs_sent_hour  < msg_per_hour
               AND msgs_sent_today < msg_per_day
               AND (allowed_types IS NULL OR allowed_types @> '["campaign"]'::jsonb)
             ) AS eligible
      FROM whatsapp_lines
      ORDER BY priority ASC
    `)
    return NextResponse.json({ lines })
  } catch (e) {
    console.error('[/api/lines GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// PATCH /api/lines — toggle sending_enabled for a line
// Body: { id: string; sending_enabled: boolean }
export async function PATCH(req: Request) {
  const err = await checkPermission(req, 'lines', 'update')
  if (err) return err

  let body: { id?: string; sending_enabled?: boolean }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { id, sending_enabled } = body
  if (!id || !isUUID(id))
    return NextResponse.json({ error: 'id is required and must be a valid UUID' }, { status: 400 })
  if (typeof sending_enabled !== 'boolean')
    return NextResponse.json({ error: 'sending_enabled must be a boolean' }, { status: 400 })

  try {
    const rows = await query<{ id: string }>(
      `UPDATE whatsapp_lines SET sending_enabled = $1, updated_at = NOW()
       WHERE id = $2 RETURNING id`,
      [sending_enabled, id]
    )
    if (rows.length === 0)
      return NextResponse.json({ error: 'Line not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/lines PATCH]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
