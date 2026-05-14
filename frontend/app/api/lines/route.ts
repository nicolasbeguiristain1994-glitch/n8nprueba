import { NextRequest, NextResponse } from 'next/server'
import { query, withTransaction } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { parseBody, handleValidationError, PatchLineSchema, CreateLineSchema, DeleteLineSchema } from '@/lib/schema'
import { lineEligibleExpr } from '@/lib/line-eligibility'

export async function GET(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'read')
  if (err) return err

  try {
    // Resetea contadores vencidos antes de devolver los datos
    await query(`SELECT reset_line_counters_if_due()`).catch(() => {})

    const lines = await query(`
      SELECT id, line_key, display_name, phone_number, evolution_instance,
             status, is_connected, sending_enabled,
             msgs_sent_today, msgs_sent_hour,
             msg_per_day, msg_per_hour, total_sent, total_failed,
             priority, last_seen_at,
             ${lineEligibleExpr()} AS eligible
      FROM whatsapp_lines
      ORDER BY priority ASC, evolution_instance ASC
    `)
    return NextResponse.json({ lines })
  } catch (e) {
    console.error('[/api/lines GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// PATCH /api/lines — update a line's fields
// Body: { id: string; sending_enabled?: boolean; display_name?: string; msg_per_day?: number; msg_per_hour?: number; priority?: number }
export async function PATCH(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'update')
  if (err) return err

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(PatchLineSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'lines')

  const { id, sending_enabled, display_name, msg_per_day, msg_per_hour, priority } = parsed.data

  const sets: string[] = ['updated_at = NOW()']
  const params: unknown[] = []

  if (sending_enabled !== undefined) { params.push(sending_enabled); sets.push(`sending_enabled = $${params.length}`) }
  if (display_name    !== undefined) { params.push(display_name);    sets.push(`display_name = $${params.length}`) }
  if (msg_per_day     !== undefined) { params.push(msg_per_day);     sets.push(`msg_per_day = $${params.length}`) }
  if (msg_per_hour    !== undefined) { params.push(msg_per_hour);    sets.push(`msg_per_hour = $${params.length}`) }
  if (priority        !== undefined) { params.push(priority);        sets.push(`priority = $${params.length}`) }

  if (params.length === 0)
    return NextResponse.json({ error: 'No hay campos para actualizar' }, { status: 400 })

  params.push(id)
  try {
    const rows = await query<{ id: string }>(
      `UPDATE whatsapp_lines SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
      params
    )
    if (rows.length === 0)
      return NextResponse.json({ error: 'Line not found' }, { status: 404 })
    const changedFields = (['sending_enabled', 'display_name', 'msg_per_day', 'msg_per_hour', 'priority'] as const)
      .filter(k => parsed.data[k] !== undefined)
    void audit({ req, action: 'update', resource: 'lines', resource_id: id,
      metadata: { changedFields } })
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

  const rawBody = await req.json().catch(() => null)
  const parsedPost = parseBody(CreateLineSchema, rawBody)
  if (!parsedPost.ok) return handleValidationError(req, parsedPost.error, 'lines')

  const { evolution_instance, display_name, phone_number } = parsedPost.data

  const line_key    = evolution_instance.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const evo_url     = process.env.EVOLUTION_URL ?? 'http://evolution-api:8080'

  try {
    const inserted = await query<{ id: string }>(
      `INSERT INTO whatsapp_lines
         (line_key, display_name, phone_number, evolution_instance, evolution_url, status, is_connected)
       VALUES ($1, $2, $3, $4, $5, 'active', true)
       ON CONFLICT (evolution_instance) DO NOTHING
       RETURNING id`,
      [line_key, display_name || evolution_instance, phone_number || null, evolution_instance, evo_url]
    )

    if (!inserted.length)
      return NextResponse.json({ error: 'Esta instancia ya existe como línea' }, { status: 409 })

    void audit({ req, action: 'create', resource: 'lines', resource_id: inserted[0].id,
      metadata: { evolution_instance, display_name } })

    return NextResponse.json({ ok: true, id: inserted[0].id })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[/api/lines POST]', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// DELETE /api/lines — eliminar una línea de la DB y su instancia de Evolution
// Body: { id: string }
export async function DELETE(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err

  const rawBody = await req.json().catch(() => null)
  const parsedDel = parseBody(DeleteLineSchema, rawBody)
  if (!parsedDel.ok) return handleValidationError(req, parsedDel.error, 'lines')

  const { id } = parsedDel.data

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


    void audit({ req, action: 'delete', resource: 'lines', resource_id: id,
      metadata: { evolution_instance, display_name } })

    // Best-effort: desconectar la sesión WhatsApp de la instancia al eliminar la línea.
    // No hacemos DELETE /instance/delete porque el negocio puede querer
    // reusar la instancia en Evolution. Solo hacemos logout para liberar
    // la sesión activa de WhatsApp sin dejar el número vinculado a una línea
    // que ya no existe en el sistema.
    const evoUrl = process.env.EVOLUTION_URL
    const evoKey = process.env.EVOLUTION_GLOBAL_API_KEY ?? process.env.EVOLUTION_API_KEY
    if (evoUrl && evoKey && evolution_instance) {
      void fetch(
        `${evoUrl}/instance/logout/${encodeURIComponent(evolution_instance)}`,
        { method: 'DELETE', headers: { apikey: evoKey } },
      ).catch(e => console.warn('[lines/delete] Evolution logout failed (best-effort):', e?.message))
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException & { code?: string }).code === 'NOT_FOUND')
      return NextResponse.json({ error: 'Line not found' }, { status: 404 })
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[/api/lines DELETE]', msg)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
