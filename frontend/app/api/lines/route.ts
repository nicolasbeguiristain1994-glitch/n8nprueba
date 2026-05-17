import { NextRequest, NextResponse } from 'next/server'
import { query, withTransaction } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { parseBody, handleValidationError, PatchLineSchema, CreateLineSchema, DeleteLineSchema } from '@/lib/schema'
import { lineEligibleExpr } from '@/lib/line-eligibility'
import { getAccessibleLineIds, lineVisibilityClause } from '@/lib/line-visibility'

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lines', 'read')
  if (!auth.ok) return auth.response

  try {
    // Resetea contadores vencidos antes de devolver los datos
    await query(`SELECT reset_line_counters_if_due()`).catch(() => {})

    const ids = await getAccessibleLineIds(auth.user)
    const { clause, params } = lineVisibilityClause(ids, '', 1)

    const lines = await query(`
      SELECT l.id, l.line_key, l.display_name, l.phone_number, l.evolution_instance,
             l.status, l.is_connected, l.sending_enabled, l.line_type,
             l.msgs_sent_today, l.msgs_sent_hour,
             l.msg_per_day, l.msg_per_hour, l.total_sent, l.total_failed,
             l.priority, l.last_seen_at, l.owner_user_id,
             ${lineEligibleExpr('l')} AS eligible,
             cn.phone_number_id AS cloud_phone_number_id,
             cn.waba_id         AS cloud_waba_id,
             cn.quality_rating  AS cloud_quality_rating,
             cn.chatwoot_inbox_id,
             cn.chatwoot_inbox_name,
             cn.status          AS cloud_status
      FROM whatsapp_lines l
      LEFT JOIN cloud_numbers cn ON cn.whatsapp_line_id = l.id
      WHERE 1=1 ${clause}
      ORDER BY l.priority ASC, l.evolution_instance ASC
    `, params)
    return NextResponse.json({ lines })
  } catch (e) {
    console.error('[/api/lines GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// PATCH /api/lines — update a line's fields
// Body: { id, sending_enabled?, display_name?, msg_per_day?, msg_per_hour?, priority? }
// Authorization: user must be able to access the line (accessible via ownership or grant).
//   sending_enabled is admin-only (kill switch that affects all campaigns on that line).
export async function PATCH(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lines', 'update')
  if (!auth.ok) return auth.response

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(PatchLineSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'lines')

  const { id, sending_enabled, display_name, msg_per_day, msg_per_hour, priority } = parsed.data
  const session = auth.user
  const isAdmin = session.role === 'admin' || session.is_super_admin

  // Operators can only modify their own lines (not shared/granted lines)
  if (!isAdmin) {
    const [line] = await query<{ owner_user_id: string | null }>(
      'SELECT owner_user_id FROM whatsapp_lines WHERE id = $1',
      [id],
    )
    if (!line) return NextResponse.json({ error: 'Line not found' }, { status: 404 })
    if (line.owner_user_id !== session.user_id)
      return NextResponse.json({ error: 'Forbidden: solo podés editar tus propias líneas' }, { status: 403 })
  } else {
    // Admin: must be an accessible line
    const ids = await getAccessibleLineIds(session)
    if (ids !== null && !ids.includes(id))
      return NextResponse.json({ error: 'Line not found or not accessible' }, { status: 404 })
  }

  // sending_enabled is a global kill switch — admin only
  if (sending_enabled !== undefined && !isAdmin)
    return NextResponse.json({ error: 'Forbidden: solo admins pueden cambiar sending_enabled' }, { status: 403 })

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
// Sets owner_user_id = session.user_id (all roles can create lines; they own what they create).
export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lines', 'manage')
  if (!auth.ok) return auth.response

  const rawBody = await req.json().catch(() => null)
  const parsedPost = parseBody(CreateLineSchema, rawBody)
  if (!parsedPost.ok) return handleValidationError(req, parsedPost.error, 'lines')

  const { evolution_instance, display_name, phone_number } = parsedPost.data
  const session = auth.user

  const line_key = evolution_instance.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const evo_url  = process.env.EVOLUTION_URL ?? 'http://evolution-api:8080'

  // owner_user_id is always the creating user. Bootstrap sessions (user_id='bootstrap')
  // are treated as super_admin — their lines remain ownerless (NULL) for system visibility.
  const ownerUserId = session.user_id === 'bootstrap' ? null : session.user_id

  try {
    const inserted = await query<{ id: string }>(
      `INSERT INTO whatsapp_lines
         (line_key, display_name, phone_number, evolution_instance, evolution_url,
          status, is_connected, owner_user_id)
       VALUES ($1, $2, $3, $4, $5, 'active', true, $6)
       ON CONFLICT (evolution_instance) DO NOTHING
       RETURNING id`,
      [line_key, display_name || evolution_instance, phone_number || null,
       evolution_instance, evo_url, ownerUserId]
    )

    if (!inserted.length)
      return NextResponse.json({ error: 'Esta instancia ya existe como línea' }, { status: 409 })

    void audit({ req, action: 'create', resource: 'lines', resource_id: inserted[0].id,
      metadata: { evolution_instance, display_name, owner_user_id: ownerUserId } })

    return NextResponse.json({ ok: true, id: inserted[0].id })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[/api/lines POST]', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// DELETE /api/lines — eliminar una línea de la DB y desconectar su instancia de Evolution
// Body: { id }
// Authorization: admin-only (manage permission). Admin must own or manage the line.
export async function DELETE(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lines', 'manage')
  if (!auth.ok) return auth.response

  const rawBody = await req.json().catch(() => null)
  const parsedDel = parseBody(DeleteLineSchema, rawBody)
  if (!parsedDel.ok) return handleValidationError(req, parsedDel.error, 'lines')

  const { id } = parsedDel.data
  const session = auth.user

  // Verify the admin has access to this specific line before deleting it.
  // super_admin bypasses this check (can delete any line).
  if (!session.is_super_admin) {
    const accessibleIds = await getAccessibleLineIds(session)
    if (accessibleIds !== null && !accessibleIds.includes(id))
      return NextResponse.json({ error: 'Line not found or not accessible' }, { status: 404 })
  }

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

    // Best-effort: log out the WhatsApp session without destroying the Evolution instance.
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
