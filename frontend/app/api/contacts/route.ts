import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
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
    const { sql, params } = await resolvedContactFilters(sp, user)
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
    const rows = await contactRead(`
      SELECT id, phone_number, first_name, last_name, email,
        status, opt_in_marketing AS opt_in, created_at, segment, panel, gaming::text AS gaming, linea, linea_sub,
        last_deposit_at, total_deposits, total_withdrawals, casino_accounts,
        (SELECT REPLACE(tag, 'casino:actividad:', '') FROM contact_tags
         WHERE contact_id = contacts.id AND tag LIKE 'casino:actividad:%' ORDER BY added_at DESC, tag LIMIT 1) AS actividad,
        (SELECT REPLACE(tag, 'casino:valor_riesgo:', '') FROM contact_tags
         WHERE contact_id = contacts.id AND tag LIKE 'casino:valor_riesgo:%' ORDER BY added_at DESC, tag LIMIT 1) AS valor_riesgo,
        (SELECT REPLACE(tag, 'casino:antiguedad:', '') FROM contact_tags
         WHERE contact_id = contacts.id AND tag LIKE 'casino:antiguedad:%' ORDER BY added_at DESC, tag LIMIT 1) AS antiguedad,
        platforms,
        COALESCE((SELECT ARRAY_AGG(tag ORDER BY tag) FROM contact_tags
          WHERE contact_id = contacts.id AND tag NOT LIKE 'casino:%'), '{}') AS custom_tags
      FROM contacts WHERE ${sql}
      ORDER BY created_at DESC, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset])
    const [{ count }] = await contactRead<{ count: string }>(`SELECT COUNT(*) FROM contacts WHERE ${sql}`, params)
    return NextResponse.json({ contacts: rows, total: Number(count), page, limit })
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

  const { phone, name, panel, gaming, segment, linea, linea_sub } = body
  const phone_clean = (phone || '').toString().trim().replace(/\s/g, '')
  if (!phone_clean) return NextResponse.json({ error: 'Teléfono requerido' }, { status: 400 })
  if (!isE164(phone_clean)) return NextResponse.json({ error: 'Teléfono debe estar en formato E.164 (ej: +5491112345678)' }, { status: 400 })

  const nameParts = (name || '').trim().split(' ')
  const first_name = nameParts[0] || null
  const last_name  = nameParts.slice(1).join(' ') || null
  const lineaVal = linea ? Number(linea) : null
  // Sub-variante solo válida (a/b/c) y solo cuando hay línea asignada
  const lineaSubRaw = (linea_sub || '').toLowerCase()
  const lineaSubVal = lineaVal !== null && ['a', 'b', 'c'].includes(lineaSubRaw) ? lineaSubRaw : null

  try {
    const [row] = await query<{ id: string }>(
      `INSERT INTO contacts
         (external_id, phone_number, first_name, last_name, segment, panel, gaming, linea, linea_sub, status,
          opt_in_marketing, opt_in_sms, platform_source, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4::contact_segment, $5, $6::gaming_type, $7, $8, 'active', true, true, 'manual', NOW(), NOW())
       ON CONFLICT (phone_number) DO NOTHING
       RETURNING id`,
      [phone_clean, first_name, last_name, segment || null, panel || null, gaming || null, lineaVal, lineaSubVal]
    )
    if (!row) return NextResponse.json({ error: 'Ya existe un contacto con ese teléfono' }, { status: 409 })
    void audit({ req, action: 'create', resource: 'contacts', resource_id: row.id,
      metadata: { phone: phone_clean } })
    return NextResponse.json({ id: row.id })
  } catch (e: unknown) {
    console.error('[/api/contacts POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
