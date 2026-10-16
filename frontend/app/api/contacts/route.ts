import { canonicalContactAgent, contactAccountKey } from '@/lib/contact-account-identity'
import { readContactHistory } from '@/lib/contact-history'
import { segmentationSQL } from '@/lib/contact-segmentation'
import { canAssignPanels, grantCreatedContacts } from '@/lib/contact-visibility'
import { NextRequest, NextResponse } from 'next/server'
import { query, withTransaction } from '@/lib/db'
import { contactRead, ContactReadUnavailableError } from '@/lib/contact-read'
import { isE164 } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { resolvedContactFilters, ContactFilterError } from '@/lib/contact-filters'
import { getAppSetting } from '@/lib/app-settings'

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth
  const sp = req.nextUrl.searchParams
  const download = sp.get('download') === 'true'
  const selectAll = sp.get('select_all') === 'true'
  const page = Number(sp.get('page') || 1)
  const from = Number(sp.get('from') || 0)
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(from) || from < 0) {
    return NextResponse.json({ error: 'Paginación inválida' }, { status: 400 })
  }
  if (download) {
    const enabled = await getAppSetting<boolean>('perms_contacts_export_global', true)
    if (!enabled || !user.can_download_contacts) return NextResponse.json({ error: 'Sin permiso para descargar contactos' }, { status: 403 })
  }
  try {
    const { sql, params, movementHistory, movementMode } = await resolvedContactFilters(sp, user)
    if (selectAll) {
      const rows = await contactRead<{ id: string; phone_number: string }>(
        `SELECT id, phone_number FROM contacts WHERE ${sql} ORDER BY created_at DESC, id LIMIT 100001`, params,
      )
      // Never silently select a partial audience for a subsequent bulk action.
      if (rows.length > 100000) return NextResponse.json({ error: 'La selección supera 100.000 contactos. Acotá los filtros para seleccionar la audiencia completa.' }, { status: 422 })
      return NextResponse.json({ ids: rows.map(r => r.id), phones: rows.map(r => r.phone_number) })
    }
    const limit = download ? 100000 : 50
    const offset = (download ? from : 0) + (page - 1) * limit
    const profile = segmentationSQL()
    const [rows, [{ count }]] = await Promise.all([
      contactRead<{ id: string; phone_number: string } & Record<string, unknown>>(`
      SELECT id, phone_number, first_name, last_name, email,
        status, opt_in_marketing AS opt_in, created_at, ${profile.segment} AS segment, segment_is_manual, segmentation_profile, ${profile.quality} AS data_quality, panel, gaming::text AS gaming, linea, linea_sub,
        last_deposit_at, total_deposits, total_withdrawals, casino_accounts,
        ${profile.activity} AS actividad, ${profile.tenure} AS antiguedad,
        CASE WHEN ${profile.activity} IN ('perdido','inactivo','en_riesgo') THEN
          CASE WHEN ${profile.segment} IN ('super_vip','vip_alto','vip_medio','vip') THEN 'critico'
          WHEN ${profile.segment}='medio' THEN 'medio' WHEN ${profile.segment}='bajo' THEN 'bajo' END END AS valor_riesgo,
        platforms,
        COALESCE((SELECT ARRAY_AGG(tag ORDER BY tag) FROM contact_tags
          WHERE contact_id = contacts.id AND tag NOT LIKE 'casino:%'), '{}') AS custom_tags
      FROM contacts WHERE ${sql}
      ORDER BY created_at DESC, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]),
      contactRead<{ count: string }>(`SELECT COUNT(*) FROM contacts WHERE ${sql}`, params),
    ])
    const resolvedMovements = movementHistory.size && movementMode !== 'period' ? movementHistory : undefined
    // Interactive pages can render their exact audience before supplementary
    // history finishes. Exports and existing callers still get complete rows.
    if (!download && sp.get('history') === 'deferred') {
      const contacts = rows.map(row => {
        const movement = resolvedMovements?.get(row.id)
        return movement ? { ...row, last_movement_date: movement.last_movement, days_since_last_movement: movement.days_inactive } : row
      })
      return NextResponse.json({ contacts, total: Number(count), page, limit }, { headers: { 'Cache-Control': 'private, no-store' } })
    }
    const history = new Map((await readContactHistory(rows, resolvedMovements)).map(row => [row.id, row]))
    const contacts = rows.map(row => ({ ...row, ...history.get(row.id) }))
    return NextResponse.json({ contacts, total: Number(count), page, limit }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    if (e instanceof ContactReadUnavailableError) return NextResponse.json({ error: e.message }, { status: 503, headers: { 'Retry-After': '3' } })
    if (e instanceof ContactFilterError) return NextResponse.json({ error: e.message }, { status: 400 })
    console.error('[/api/contacts GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const err = await checkPermissionWithUser(req, 'contacts', 'create')
  if (!err.ok) return err.response

  let body: { phone?: string; name?: string; panel?: string; gaming?: string; segment?: string; linea?: string | number; linea_sub?: string }
  try {
    body = await (req as NextRequest).json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { phone, name, gaming, segment, linea, linea_sub } = body
  const panel=canonicalContactAgent(body.panel)
  const username=name?.trim().toLowerCase() || null
  const phone_clean = (phone || '').toString().trim().replace(/\s/g, '')
  if (!phone_clean) return NextResponse.json({ error: 'Teléfono requerido' }, { status: 400 })
  if (!isE164(phone_clean)) return NextResponse.json({ error: 'Teléfono debe estar en formato E.164 (ej: +5491112345678)' }, { status: 400 })

  if (!canAssignPanels(err.user, [panel || null])) return NextResponse.json({error: 'Agente fuera de tu alcance'}, {status: 403})

  const nameParts = (name || '').trim().split(' ')
  const first_name = nameParts[0] || null
  const last_name  = nameParts.slice(1).join(' ') || null
  const lineaVal = linea ? Number(linea) : null
  // Sub-variante solo válida (a/b/c) y solo cuando hay línea asignada
  const lineaSubRaw = (linea_sub || '').toLowerCase()
  const lineaSubVal = lineaVal !== null && ['a', 'b', 'c'].includes(lineaSubRaw) ? lineaSubRaw : null

  try {
    const row = await withTransaction(async client => {
      const {rows: [created]} = await client.query<{ id: string }>(
      `INSERT INTO contacts
         (external_id, phone_number, first_name, last_name, segment, panel, gaming, linea, linea_sub, status,
          opt_in_marketing, opt_in_sms, platform_source, created_at, updated_at, segment_is_manual,account_username,identity_key,panels_assigned,casino_accounts)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4::contact_segment, $5, $6::gaming_type, $7, $8, 'active', true, true, 'manual', NOW(), NOW(), $4::text IS NOT NULL,$9,$10,CASE WHEN $5::text IS NULL THEN '{}'::text[] ELSE ARRAY[$5]::text[] END,
         CASE WHEN $9::text IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('panel',$5::text,'username',$9::text)) END)
       ON CONFLICT (identity_key) DO NOTHING
       RETURNING id`,
      [phone_clean, first_name, last_name, segment || null, panel || null, gaming || null, lineaVal, lineaSubVal,username,contactAccountKey(panel,username,phone_clean)]
    )
      if (created) await grantCreatedContacts(client, err.user, [created.id])
      return created
    })
    if (!row) return NextResponse.json({ error: 'Ya existe esa cuenta en el agente seleccionado' }, { status: 409 })
    void audit({ req, action: 'create', resource: 'contacts', resource_id: row.id,
      metadata: { phone: phone_clean } })
    return NextResponse.json({ id: row.id })
  } catch (e: unknown) {
    console.error('[/api/contacts POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
