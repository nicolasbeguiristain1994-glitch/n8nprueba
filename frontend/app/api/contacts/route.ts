import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isE164 } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { visibilityClause } from '@/lib/contact-visibility'
import { getAppSetting } from '@/lib/app-settings'

const ACTIVIDAD_ALLOWED  = new Set(['nuevo', 'frecuente', 'regular', 'ocasional', 'en_riesgo', 'inactivo', 'perdido'])
const ANTIGUEDAD_ALLOWED = new Set(['nuevo', 'reciente', 'establecido', 'veterano', 'leal'])
const PLATAFORMA_ALLOWED = new Set(['zeus', 'bet30', 'otros'])
const SEGMENT_ALLOWED    = new Set(['bajo', 'medio', 'vip', 'vip_medio', 'vip_alto', 'super_vip'])

// Mapeo de nombres de agente en la UI → nombre real en la columna `panel` de la DB.
const PANEL_ALIAS_MAP: Record<string, string> = {}

// Aliases cross-plataforma: mismos agentes con distinto nombre en Zeus vs Bet30.
// Al filtrar por cualquiera de los dos, se muestran los contactos de ambos.
const PANEL_CROSS: Record<string, string[]> = {
  betcoin:   ['betcoin',   'btcuno'],
  btcuno:    ['btcuno',    'betcoin'],
  farabet:   ['farabet',   'btcdos'],
  btcdos:    ['btcdos',    'farabet'],
  ofizeus:   ['ofizeus',   'zeus'],
  zeus:      ['zeus',      'ofizeus'],
  royal:     ['royal',     'zeusroyal'],
  zeusroyal: ['zeusroyal', 'royal'],
  bigwin:    ['bigwin'],
  adminbet:  ['adminbet'],
  surmar:    ['surmar'],
}

// Platform filters use the persisted `platforms` column (maintained by
// trg_contact_platforms trigger in migration 075). GIN-indexed for fast lookups.
const ZEUS_FILTER  = `'zeus'  = ANY(platforms)`
const BET30_FILTER = `'bet30' = ANY(platforms)`
const OTROS_FILTER = `NOT 'zeus' = ANY(platforms) AND NOT 'bet30' = ANY(platforms)`

export async function GET(req: NextRequest) {
  let auth: Awaited<ReturnType<typeof checkPermissionWithUser>>
  try {
    auth = await checkPermissionWithUser(req, 'contacts', 'read')
  } catch (e) {
    const err = e as Record<string, unknown>
    console.error('[/api/contacts GET auth]', { message: err?.message, code: err?.code, detail: err?.detail })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
  if (!auth.ok) return auth.response
  const { user } = auth

  const search    = req.nextUrl.searchParams.get('q') || ''
  const segmentRaw = req.nextUrl.searchParams.get('segment') || ''
  const segments   = segmentRaw ? segmentRaw.split(',').filter(s => SEGMENT_ALLOWED.has(s)) : []
  // PostgreSQL array literal: '{}' means no filter, '{vip,super_vip}' filters to those values
  const segmentParam = segments.length > 0 ? `{${segments.join(',')}}` : '{}'
  const gaming    = req.nextUrl.searchParams.get('gaming') || ''
  const panelRaw   = req.nextUrl.searchParams.get('panel') || ''
  const panelNorm  = (PANEL_ALIAS_MAP[panelRaw] ?? panelRaw).toLowerCase()
  // Incluye aliases cross-plataforma (ej: betcoin → [betcoin, btcuno])
  const panelList  = panelNorm ? (PANEL_CROSS[panelNorm] ?? [panelNorm]) : []
  const panelParam = panelList.length > 0 ? `{${panelList.join(',')}}` : '{}'
  const download  = req.nextUrl.searchParams.get('download') === 'true'
  const selectAll = req.nextUrl.searchParams.get('select_all') === 'true'
  const page      = Number(req.nextUrl.searchParams.get('page') || 1)
  const dlFrom    = download ? Math.max(0, Number(req.nextUrl.searchParams.get('from') || '0')) : 0
  const limit     = download ? 100000 : 50
  const offset    = download ? dlFrom + (page - 1) * limit : (page - 1) * limit
  const linea      = req.nextUrl.searchParams.get('linea') || ''
  const actividadRaw   = req.nextUrl.searchParams.get('actividad') || ''
  const antiguedadRaw  = req.nextUrl.searchParams.get('antiguedad') || ''
  const actividadList  = actividadRaw  ? actividadRaw.split(',').filter(v  => ACTIVIDAD_ALLOWED.has(v))  : []
  const antiguedadList = antiguedadRaw ? antiguedadRaw.split(',').filter(v => ANTIGUEDAD_ALLOWED.has(v)) : []
  const actividadParam  = actividadList.length  > 0 ? `{${actividadList.join(',')}}` : '{}'
  const antiguedadParam = antiguedadList.length > 0 ? `{${antiguedadList.join(',')}}` : '{}'
  const listIdRaw  = req.nextUrl.searchParams.get('list_id') || ''
  const listId     = listIdRaw && /^[0-9a-f-]{36}$/i.test(listIdRaw) ? listIdRaw : ''
  const plataforma    = req.nextUrl.searchParams.get('plataforma') || ''
  const filterTag     = (req.nextUrl.searchParams.get('tag') || '').trim().slice(0, 100)
  // Filtro "Sin movimiento": contactos sin depósitos en los últimos 12 meses
  const sinMovimiento = req.nextUrl.searchParams.get('sin_movimiento') === 'true'

  // Los valores inválidos se descartan silenciosamente en el split+filter de arriba
  if (plataforma && !PLATAFORMA_ALLOWED.has(plataforma)) {
    return NextResponse.json({ error: `Invalid plataforma "${plataforma}"` }, { status: 400 })
  }

  // Simple array checks against the stored `platforms` column (GIN index)
  const plataformaFilter = plataforma === 'zeus'  ? ` AND ${ZEUS_FILTER}`
                         : plataforma === 'bet30' ? ` AND ${BET30_FILTER}`
                         : plataforma === 'otros' ? ` AND (${OTROS_FILTER})`
                         : ''

  // Sin movimiento: last_deposit_at nulo o anterior a hace 12 meses
  const sinMovimientoFilter = sinMovimiento
    ? ` AND (last_deposit_at IS NULL OR last_deposit_at < NOW() - INTERVAL '12 months')`
    : ''

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
      ? ` AND panels_assigned && $${8 + vis2.params.length}::text[]`
      : ''
    const agentParams2 = agentAllowed ? [agentAllowed] : []
    try {
      const idRows = await query<{ id: string; phone_number: string }>(`
        SELECT id, phone_number FROM contacts
        WHERE ($1 = '' OR phone_number ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1)
          AND ($2 = '{}' OR segment::text = ANY($2::text[]))
          AND ($3 = '' OR gaming::text = $3)
          AND ($4 = '{}' OR panel = ANY($4::text[]))
          AND ($5 = '' OR linea::text = $5)
          AND ($6 = '{}' OR EXISTS (
            SELECT 1 FROM contact_tags ct
            WHERE ct.contact_id = contacts.id
              AND ct.tag LIKE 'casino:actividad:%'
              AND REPLACE(ct.tag, 'casino:actividad:', '') = ANY($6::text[])
          ))
          AND ($7 = '{}' OR EXISTS (
            SELECT 1 FROM contact_tags ct
            WHERE ct.contact_id = contacts.id
              AND ct.tag LIKE 'casino:antiguedad:%'
              AND REPLACE(ct.tag, 'casino:antiguedad:', '') = ANY($7::text[])
          ))
          ${vis2.sql}${agentFilter2}${plataformaFilter}${sinMovimientoFilter}
        ORDER BY created_at DESC
        LIMIT 100000
      `, [`%${search}%`, segmentParam, gaming, panelParam, linea, actividadParam, antiguedadParam,
          ...vis2.params, ...agentParams2])
      return NextResponse.json({ ids: idRows.map(r => r.id), phones: idRows.map(r => r.phone_number) })
    } catch (e) {
      console.error('[/api/contacts GET select_all]', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  }

  // ── Query principal ───────────────────────────────────────────────────────────
  // 10 base params: $1=%search%, $2=limit, $3=offset, $4=segment, $5=gaming,
  //                 $6=panel, $7=linea, $8=actividad, $9=antiguedad, $10=list_id
  const vis         = visibilityClause(user.role, user.user_id, 10)
  const agentFilter = agentAllowed
    ? ` AND panels_assigned && $${11 + vis.params.length}::text[]`
    : ''
  const agentParams = agentAllowed ? [agentAllowed] : []

  // tag filter — appended as last param after vis+agent params
  const tagMainIdx    = 11 + vis.params.length + agentParams.length
  const tagFilterMain = filterTag
    ? ` AND EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = contacts.id AND ct.tag ILIKE '%' || $${tagMainIdx} || '%' AND ct.tag NOT LIKE 'casino:%')`
    : ''
  const tagParams = filterTag ? [filterTag] : []

  // 8 base params for count query (no limit/offset): $1-$7 same, $8=list_id
  const vis7          = visibilityClause(user.role, user.user_id, 8)
  const agentFilterCt = agentAllowed
    ? ` AND panels_assigned && $${9 + vis7.params.length}::text[]`
    : ''
  const tagCountIdx    = 9 + vis7.params.length + agentParams.length
  const tagFilterCount = filterTag
    ? ` AND EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = contacts.id AND ct.tag ILIKE '%' || $${tagCountIdx} || '%' AND ct.tag NOT LIKE 'casino:%')`
    : ''

  try {
    // Un único LATERAL por fila reemplaza las 4 subqueries correlacionadas previas
    // (actividad, valor_riesgo, antiguedad, custom_tags). Con el índice compuesto
    // idx_contact_tags_contact_tag (contact_id, tag), cada LATERAL hace un solo
    // index scan y extrae todos los valores en una pasada.
    // Antes: 4 index seeks × 50 filas = 200 lookups/página
    // Ahora: 1 index scan  × 50 filas =  50 lookups/página
    const rows = await query(`
      SELECT
        contacts.id, contacts.phone_number, contacts.first_name, contacts.last_name, contacts.email,
        contacts.status, contacts.opt_in_marketing AS opt_in, contacts.created_at,
        contacts.segment, contacts.panel, contacts.gaming::text AS gaming, contacts.linea,
        contacts.last_deposit_at, contacts.total_deposits, contacts.total_withdrawals,
        contacts.platforms, contacts.casino_accounts,
        ct.actividad,
        ct.valor_riesgo,
        ct.antiguedad,
        ct.custom_tags
      FROM contacts
      LEFT JOIN LATERAL (
        SELECT
          MAX(CASE WHEN tag LIKE 'casino:actividad:%'
            THEN REPLACE(tag, 'casino:actividad:', '') END)    AS actividad,
          MAX(CASE WHEN tag LIKE 'casino:valor_riesgo:%'
            THEN REPLACE(tag, 'casino:valor_riesgo:', '') END) AS valor_riesgo,
          MAX(CASE WHEN tag LIKE 'casino:antiguedad:%'
            THEN REPLACE(tag, 'casino:antiguedad:', '') END)   AS antiguedad,
          COALESCE(
            ARRAY_AGG(tag ORDER BY tag) FILTER (WHERE tag NOT LIKE 'casino:%'),
            '{}'
          ) AS custom_tags
        FROM contact_tags
        WHERE contact_id = contacts.id
      ) ct ON true
      WHERE ($1 = '' OR contacts.phone_number ILIKE $1 OR contacts.first_name ILIKE $1 OR contacts.last_name ILIKE $1)
        AND ($4 = '{}' OR contacts.segment::text = ANY($4::text[]))
        AND ($5 = '' OR contacts.gaming::text = $5)
        AND ($6 = '{}' OR contacts.panel = ANY($6::text[]))
        AND ($7 = '' OR contacts.linea::text = $7)
        AND ($8 = '{}' OR EXISTS (
          SELECT 1 FROM contact_tags ct2
          WHERE ct2.contact_id = contacts.id
            AND ct2.tag LIKE 'casino:actividad:%'
            AND REPLACE(ct2.tag, 'casino:actividad:', '') = ANY($8::text[])
        ))
        AND ($9 = '{}' OR EXISTS (
          SELECT 1 FROM contact_tags ct3
          WHERE ct3.contact_id = contacts.id
            AND ct3.tag LIKE 'casino:antiguedad:%'
            AND REPLACE(ct3.tag, 'casino:antiguedad:', '') = ANY($9::text[])
        ))
        AND ($10 = '' OR contacts.id IN (
          SELECT contact_id FROM contact_list_members WHERE list_id = $10::uuid
        ))
        ${vis.sql}${agentFilter}${tagFilterMain}${plataformaFilter}${sinMovimientoFilter}
      ORDER BY contacts.created_at DESC
      LIMIT $2 OFFSET $3
    `, [`%${search}%`, limit, offset, segmentParam, gaming, panelParam, linea, actividadParam, antiguedadParam, listId,
        ...vis.params, ...agentParams, ...tagParams])

    const [{ count }] = await query<{ count: string }>(
      `SELECT COUNT(*) FROM contacts
       WHERE ($1 = '' OR phone_number ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1)
         AND ($2 = '{}' OR segment::text = ANY($2::text[]))
         AND ($3 = '' OR gaming::text = $3)
         AND ($4 = '{}' OR panel = ANY($4::text[]))
         AND ($5 = '' OR linea::text = $5)
         AND ($6 = '{}' OR EXISTS (
           SELECT 1 FROM contact_tags ct
           WHERE ct.contact_id = contacts.id
             AND ct.tag LIKE 'casino:actividad:%'
             AND REPLACE(ct.tag, 'casino:actividad:', '') = ANY($6::text[])
         ))
         AND ($7 = '{}' OR EXISTS (
           SELECT 1 FROM contact_tags ct
           WHERE ct.contact_id = contacts.id
             AND ct.tag LIKE 'casino:antiguedad:%'
             AND REPLACE(ct.tag, 'casino:antiguedad:', '') = ANY($7::text[])
         ))
         AND ($8 = '' OR id IN (
           SELECT contact_id FROM contact_list_members WHERE list_id = $8::uuid
         ))
         ${vis7.sql}${agentFilterCt}${tagFilterCount}${plataformaFilter}${sinMovimientoFilter}`,
      [`%${search}%`, segmentParam, gaming, panelParam, linea, actividadParam, antiguedadParam, listId,
       ...vis7.params, ...agentParams, ...tagParams]
    )

    return NextResponse.json({ contacts: rows, total: Number(count), page, limit })
  } catch (e) {
    const err = e as Record<string, unknown>
    console.error('[/api/contacts GET]', {
      message: err?.message, code: err?.code, detail: err?.detail, stack: err?.stack,
    })
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
