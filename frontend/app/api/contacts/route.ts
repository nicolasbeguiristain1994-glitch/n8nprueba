import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isE164 } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { visibilityClause } from '@/lib/contact-visibility'
import { getAppSetting } from '@/lib/app-settings'

const ACTIVIDAD_ALLOWED  = new Set(['nuevo', 'frecuente', 'regular', 'ocasional', 'en_riesgo', 'inactivo', 'perdido'])
const ANTIGUEDAD_ALLOWED = new Set(['nuevo', 'reciente', 'establecido', 'veterano', 'leal'])

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth

  const search    = req.nextUrl.searchParams.get('q') || ''
  const segment   = req.nextUrl.searchParams.get('segment') || ''
  const gaming    = req.nextUrl.searchParams.get('gaming') || ''
  const panel     = req.nextUrl.searchParams.get('panel') || ''
  const download  = req.nextUrl.searchParams.get('download') === 'true'
  const selectAll = req.nextUrl.searchParams.get('select_all') === 'true'
  const page      = Number(req.nextUrl.searchParams.get('page') || 1)
  const limit     = download ? 100000 : 50
  const offset    = download ? 0 : (page - 1) * limit
  const linea     = req.nextUrl.searchParams.get('linea') || ''
  const actividad = req.nextUrl.searchParams.get('actividad') || ''
  const antiguedad = req.nextUrl.searchParams.get('antiguedad') || ''

  if (actividad && !ACTIVIDAD_ALLOWED.has(actividad)) {
    return NextResponse.json({ error: `Invalid actividad "${actividad}"` }, { status: 400 })
  }
  if (antiguedad && !ANTIGUEDAD_ALLOWED.has(antiguedad)) {
    return NextResponse.json({ error: `Invalid antiguedad "${antiguedad}"` }, { status: 400 })
  }

  // Bloquear descarga si está deshabilitada globalmente o el usuario no tiene permiso
  if (download) {
    const exportGlobal = await getAppSetting<boolean>('perms_contacts_export_global', true)
    if (!exportGlobal) {
      return NextResponse.json({ error: 'La descarga de contactos está deshabilitada por el administrador' }, { status: 403 })
    }
    if (!user.can_download_contacts) {
      return NextResponse.json({ error: 'Sin permiso para descargar contactos' }, { status: 403 })
    }
  }

  // Filtro por agentes permitidos (solo no-admins con lista explícita)
  const agentAllowed = (
    user.role !== 'admin' &&
    Array.isArray(user.allowed_agents) &&
    user.allowed_agents.length > 0
  ) ? user.allowed_agents : null

  // ── select_all: devuelve solo IDs sin paginación ──────────────────────────────
  if (selectAll) {
    // 7 base params: $1=%search%, $2=segment, $3=gaming, $4=panel, $5=linea, $6=actividad, $7=antiguedad
    const vis2         = visibilityClause(user.role, user.user_id, 7)
    const agentFilter2 = agentAllowed
      ? ` AND panel = ANY($${8 + vis2.params.length}::text[])`
      : ''
    const agentParams2 = agentAllowed ? [agentAllowed] : []
    try {
      const idRows = await query<{ id: string }>(`
        SELECT id FROM contacts
        WHERE ($1 = '' OR phone_number ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1)
          AND ($2 = '' OR segment::text = $2)
          AND ($3 = '' OR gaming::text = $3)
          AND ($4 = '' OR panel = $4)
          AND ($5 = '' OR linea::text = $5)
          AND ($6 = '' OR EXISTS (
            SELECT 1 FROM contact_tags ct
            WHERE ct.contact_id = contacts.id AND ct.tag = 'casino:actividad:' || $6
          ))
          AND ($7 = '' OR EXISTS (
            SELECT 1 FROM contact_tags ct
            WHERE ct.contact_id = contacts.id AND ct.tag = 'casino:antiguedad:' || $7
          ))
          ${vis2.sql}${agentFilter2}
        ORDER BY created_at DESC
        LIMIT 100000
      `, [`%${search}%`, segment, gaming, panel, linea, actividad, antiguedad,
          ...vis2.params, ...agentParams2])
      return NextResponse.json({ ids: idRows.map(r => r.id) })
    } catch (e) {
      console.error('[/api/contacts GET select_all]', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  }

  // ── Query principal ───────────────────────────────────────────────────────────
  // 9 base params: $1=%search%, $2=limit, $3=offset, $4=segment, $5=gaming,
  //                $6=panel, $7=linea, $8=actividad, $9=antiguedad
  const vis         = visibilityClause(user.role, user.user_id, 9)
  const agentFilter = agentAllowed
    ? ` AND panel = ANY($${10 + vis.params.length}::text[])`
    : ''
  const agentParams = agentAllowed ? [agentAllowed] : []

  // 7 base params for count query (no limit/offset)
  const vis7          = visibilityClause(user.role, user.user_id, 7)
  const agentFilterCt = agentAllowed
    ? ` AND panel = ANY($${8 + vis7.params.length}::text[])`
    : ''

  try {
    const rows = await query(`
      SELECT id, phone_number, first_name, last_name, email,
             status, opt_in_marketing AS opt_in, created_at, segment, panel, gaming::text AS gaming, linea,
             (SELECT REPLACE(tag, 'casino:actividad:', '')
              FROM contact_tags
              WHERE contact_id = contacts.id AND tag LIKE 'casino:actividad:%'
              LIMIT 1) AS actividad,
             (SELECT REPLACE(tag, 'casino:valor_riesgo:', '')
              FROM contact_tags
              WHERE contact_id = contacts.id AND tag LIKE 'casino:valor_riesgo:%'
              LIMIT 1) AS valor_riesgo,
             (SELECT REPLACE(tag, 'casino:antiguedad:', '')
              FROM contact_tags
              WHERE contact_id = contacts.id AND tag LIKE 'casino:antiguedad:%'
              LIMIT 1) AS antiguedad
      FROM contacts
      WHERE ($1 = '' OR phone_number ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1)
        AND ($4 = '' OR segment::text = $4)
        AND ($5 = '' OR gaming::text = $5)
        AND ($6 = '' OR panel = $6)
        AND ($7 = '' OR linea::text = $7)
        AND ($8 = '' OR EXISTS (
          SELECT 1 FROM contact_tags ct
          WHERE ct.contact_id = contacts.id AND ct.tag = 'casino:actividad:' || $8
        ))
        AND ($9 = '' OR EXISTS (
          SELECT 1 FROM contact_tags ct
          WHERE ct.contact_id = contacts.id AND ct.tag = 'casino:antiguedad:' || $9
        ))
        ${vis.sql}${agentFilter}
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [`%${search}%`, limit, offset, segment, gaming, panel, linea, actividad, antiguedad,
        ...vis.params, ...agentParams])

    const [{ count }] = await query<{ count: string }>(
      `SELECT COUNT(*) FROM contacts
       WHERE ($1 = '' OR phone_number ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1)
         AND ($2 = '' OR segment::text = $2)
         AND ($3 = '' OR gaming::text = $3)
         AND ($4 = '' OR panel = $4)
         AND ($5 = '' OR linea::text = $5)
         AND ($6 = '' OR EXISTS (
           SELECT 1 FROM contact_tags ct
           WHERE ct.contact_id = contacts.id AND ct.tag = 'casino:actividad:' || $6
         ))
         AND ($7 = '' OR EXISTS (
           SELECT 1 FROM contact_tags ct
           WHERE ct.contact_id = contacts.id AND ct.tag = 'casino:antiguedad:' || $7
         ))
         ${vis7.sql}${agentFilterCt}`,
      [`%${search}%`, segment, gaming, panel, linea, actividad, antiguedad,
       ...vis7.params, ...agentParams]
    )

    return NextResponse.json({ contacts: rows, total: Number(count), page, limit })
  } catch (e) {
    console.error('[/api/contacts GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const err = await checkPermissionWithUser(req, 'contacts', 'create')
  if (!err.ok) return err.response

  let body: { phone?: string; name?: string; panel?: string; gaming?: string; segment?: string; linea?: string | number }
  try {
    body = await (req as NextRequest).json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { phone, name, panel, gaming, segment, linea } = body
  const phone_clean = (phone || '').toString().trim().replace(/\s/g, '')
  if (!phone_clean) return NextResponse.json({ error: 'Teléfono requerido' }, { status: 400 })
  if (!isE164(phone_clean)) return NextResponse.json({ error: 'Teléfono debe estar en formato E.164 (ej: +5491112345678)' }, { status: 400 })

  const nameParts = (name || '').trim().split(' ')
  const first_name = nameParts[0] || null
  const last_name  = nameParts.slice(1).join(' ') || null
  const lineaVal = linea ? Number(linea) : null

  try {
    const [row] = await query<{ id: string }>(
      `INSERT INTO contacts
         (external_id, phone_number, first_name, last_name, segment, panel, gaming, linea, status,
          opt_in_marketing, opt_in_sms, platform_source, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4::contact_segment, $5, $6::gaming_type, $7, 'active', true, true, 'manual', NOW(), NOW())
       ON CONFLICT (phone_number) DO NOTHING
       RETURNING id`,
      [phone_clean, first_name, last_name, segment || null, panel || null, gaming || null, lineaVal]
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
