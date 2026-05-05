import { NextRequest, NextResponse } from 'next/server'
import { query, withTransaction } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import { audit } from '@/lib/audit'

export async function GET(req: NextRequest) {
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
export async function PATCH(req: NextRequest) {
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

// POST /api/lines — crear una línea de producción directamente desde una instancia Evolution existente
// Body: { evolution_instance, display_name?, phone_number? }
export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err

  let body: { evolution_instance?: string; display_name?: string; phone_number?: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { evolution_instance, display_name, phone_number } = body
  if (!evolution_instance || typeof evolution_instance !== 'string')
    return NextResponse.json({ error: 'evolution_instance is required' }, { status: 400 })

  const line_key = evolution_instance.toLowerCase().replace(/[^a-z0-9-]/g, '-')

  try {
    const inserted = await query<{ id: string }>(
      `INSERT INTO whatsapp_lines
         (line_key, display_name, phone_number, evolution_instance, status, is_connected)
       VALUES ($1, $2, $3, $4, 'active', true)
       ON CONFLICT (evolution_instance) DO NOTHING
       RETURNING id`,
      [line_key, display_name || evolution_instance, phone_number || null, evolution_instance]
    )

    if (!inserted.length)
      return NextResponse.json({ error: 'Esta instancia ya existe como línea' }, { status: 409 })

    void audit({ req, action: 'manage', resource: 'lines',
      metadata: { evolution_instance, display_name } })

    return NextResponse.json({ ok: true, id: inserted[0].id })
  } catch (e) {
    console.error('[/api/lines POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// DELETE /api/lines — eliminar una línea de la DB y su instancia de Evolution
// Body: { id: string }
export async function DELETE(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err

  let body: { id?: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { id } = body
  if (!id || !isUUID(id))
    return NextResponse.json({ error: 'id is required and must be a valid UUID' }, { status: 400 })

  try {
    const { evolution_instance, display_name } = await withTransaction(async (client) => {
      // Nullify FK references before deleting to avoid constraint issues under RLS
      await client.query(
        `UPDATE campaign_recipients SET line_id = NULL WHERE line_id = $1`, [id]
      )
      await client.query(
        `DELETE FROM line_usage_log WHERE line_id = $1`, [id]
      )
      const res = await client.query<{ id: string; evolution_instance: string; display_name: string }>(
        `DELETE FROM whatsapp_lines WHERE id = $1 RETURNING id, evolution_instance, display_name`, [id]
      )
      if (res.rows.length === 0) throw Object.assign(new Error('Line not found'), { code: 'NOT_FOUND' })
      return res.rows[0]
    })


    void audit({ req, action: 'manage', resource: 'lines',
      metadata: { deleted_id: id, evolution_instance, display_name } })

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException & { code?: string }).code === 'NOT_FOUND')
      return NextResponse.json({ error: 'Line not found' }, { status: 404 })
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[/api/lines DELETE]', msg)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
