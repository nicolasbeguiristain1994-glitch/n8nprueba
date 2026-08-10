import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isE164 } from '@/lib/validate'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'

export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'contacts', 'create')
  if (err) return err

  let body: {
    contacts?:      Array<{ phone: string; name?: string; segment?: string; casino_username?: string }>
    panel?:         string
    panels?:        string[]
    linea?:         number
    linea_sub?:     string
    skip_existing?: boolean
    conflict_mode?: 'update' | 'panels_only' | 'skip'
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { contacts, panel, panels, linea, linea_sub, skip_existing = false, conflict_mode } = body
  // conflict_mode takes precedence over legacy skip_existing
  const resolvedMode: 'update' | 'panels_only' | 'skip' =
    conflict_mode ?? (skip_existing ? 'skip' : 'update')
  if (!contacts?.length) return NextResponse.json({ error: 'No contacts provided' }, { status: 400 })
  if (!Array.isArray(contacts) || contacts.length > 10_000) {
    return NextResponse.json({ error: 'contacts debe ser un array de máximo 10.000 filas por chunk' }, { status: 400 })
  }

  // panels param takes precedence over legacy panel param
  const panelsRaw = (panels && panels.length > 0)
    ? panels.map(p => p.trim().toLowerCase()).filter(Boolean)
    : panel?.trim().toLowerCase() ? [panel.trim().toLowerCase()] : []

  const panelValue = panelsRaw[0] ?? null  // primary panel (first one)
  const panelsValue = panelsRaw            // all panels for panels_assigned
  const lineaValue = linea ? Number(linea) : null
  if (lineaValue !== null && (lineaValue < 1 || lineaValue > 100)) {
    return NextResponse.json({ error: 'Línea inválida (1-100)' }, { status: 400 })
  }
  // Sub-variante (a/b/c) solo válida cuando hay línea asignada
  const lineaSubRaw = (linea_sub || '').toLowerCase()
  const lineaSubValue = lineaValue !== null && ['a', 'b', 'c'].includes(lineaSubRaw) ? lineaSubRaw : null

  // Normalize and pre-filter in JS — count skipped rows before hitting DB
  // Deduplicate phones before SQL; only validate E.164 rows (skip invalid silently)
  const seen = new Set<string>()
  let invalidCount = 0
  const normalized: Array<{ phone: string; name: string | null; segment: string | null; casino_username: string | null }> = []

  for (const c of contacts) {
    const rawPhone = (c.phone || '').toString().trim().replace(/\s/g, '')
    if (!rawPhone) continue
    if (!isE164(rawPhone)) { invalidCount++; continue }
    if (seen.has(rawPhone)) continue
    seen.add(rawPhone)
    // casino_username: campo explícito > fallback al campo name
    const casinoUsername = (c.casino_username || c.name || '').trim() || null
    const rawSeg = (c.segment || '').trim().toLowerCase()
    const VALID_SEGMENTS = ['casual', 'regular', 'super_vip', 'vip_alto', 'vip_medio', 'vip', 'whale', 'bajo', 'medio']
    const rawName = (c.name || '').trim()
    normalized.push({
      phone:           rawPhone,
      name:            rawName ? rawName.slice(0, 100) : null,
      segment:         VALID_SEGMENTS.includes(rawSeg) ? rawSeg : null,
      casino_username: casinoUsername ? casinoUsername.slice(0, 100) : null,
    })
  }

  const skipped = contacts.length - normalized.length - invalidCount

  if (normalized.length === 0) {
    return NextResponse.json({ inserted: 0, updated: 0, skipped: skipped + invalidCount, invalid: invalidCount, total: contacts.length })
  }

  // Single bulk upsert via jsonb_to_recordset — N individual queries → 1 query.
  // xmax = 0 means the row was inserted; non-zero means updated (Postgres internal).
  try {
    const [row] = await query<{ inserted: string; updated: string }>(
      `WITH input AS (
         SELECT phone, name, segment, casino_username,
                $2::text AS panel_val
         FROM   jsonb_to_recordset($1::jsonb)
                AS x(phone text, name text, segment text, casino_username text)
       ), upserted AS (
         INSERT INTO contacts
           (external_id, phone_number, first_name, segment, panel, panels_assigned, casino_accounts, linea, linea_sub, status,
            opt_in_marketing, opt_in_sms, platform_source, created_at, updated_at)
         SELECT
           gen_random_uuid()::text,
           phone,
           NULLIF(name, ''),
           NULLIF(segment, '')::contact_segment,
           panel_val,
           ARRAY(SELECT jsonb_array_elements_text($4::jsonb)),
           CASE
             WHEN panel_val IS NOT NULL AND NULLIF(name, '') IS NOT NULL
               THEN jsonb_build_array(jsonb_build_object('panel', panel_val, 'username', NULLIF(name, '')))
             ELSE '[]'::jsonb
           END,
           $3,
           $5,
           'active', true, true, 'import', NOW(), NOW()
         FROM input
         ON CONFLICT (phone_number) DO ${
           resolvedMode === 'skip' ? 'NOTHING'
         : resolvedMode === 'panels_only' ? `UPDATE
           SET panels_assigned = (
                 SELECT ARRAY(
                   SELECT DISTINCT unnest
                   FROM unnest(contacts.panels_assigned || EXCLUDED.panels_assigned)
                   WHERE unnest IS NOT NULL
                   ORDER BY unnest
                 )
               ),
               casino_accounts = CASE
                 WHEN EXCLUDED.first_name IS NULL OR EXCLUDED.panel IS NULL
                   THEN contacts.casino_accounts
                 WHEN EXISTS (
                   SELECT 1 FROM jsonb_array_elements(contacts.casino_accounts) e
                   WHERE (e->>'panel') = EXCLUDED.panel AND (e->>'username') = EXCLUDED.first_name
                 )
                   THEN contacts.casino_accounts
                 ELSE contacts.casino_accounts || jsonb_build_array(
                   jsonb_build_object('panel', EXCLUDED.panel, 'username', EXCLUDED.first_name)
                 )
               END,
               linea      = COALESCE(EXCLUDED.linea, contacts.linea),
               linea_sub  = COALESCE(EXCLUDED.linea_sub, contacts.linea_sub),
               updated_at = NOW()`
         : /* update */ `UPDATE
           SET first_name        = COALESCE(EXCLUDED.first_name, contacts.first_name),
               segment           = COALESCE(EXCLUDED.segment,    contacts.segment),
               panel             = COALESCE(EXCLUDED.panel,      contacts.panel),
               panels_assigned   = (
                 SELECT ARRAY(
                   SELECT DISTINCT unnest
                   FROM unnest(contacts.panels_assigned || EXCLUDED.panels_assigned)
                   WHERE unnest IS NOT NULL
                   ORDER BY unnest
                 )
               ),
               casino_accounts = CASE
                 WHEN EXCLUDED.first_name IS NULL OR EXCLUDED.panel IS NULL
                   THEN contacts.casino_accounts
                 WHEN EXISTS (
                   SELECT 1 FROM jsonb_array_elements(contacts.casino_accounts) e
                   WHERE (e->>'panel') = EXCLUDED.panel AND (e->>'username') = EXCLUDED.first_name
                 )
                   THEN contacts.casino_accounts
                 ELSE contacts.casino_accounts || jsonb_build_array(
                   jsonb_build_object('panel', EXCLUDED.panel, 'username', EXCLUDED.first_name)
                 )
               END,
               linea             = COALESCE(EXCLUDED.linea,      contacts.linea),
               linea_sub         = COALESCE(EXCLUDED.linea_sub,  contacts.linea_sub),
               updated_at        = NOW()`}
         RETURNING id, xmax::text
       )
       SELECT
         COUNT(*) FILTER (WHERE xmax = '0')  AS inserted,
         COUNT(*) FILTER (WHERE xmax != '0') AS updated
       FROM upserted`,
      [JSON.stringify(normalized), panelValue, lineaValue, JSON.stringify(panelsValue), lineaSubValue]
    )

    const inserted = Number(row?.inserted || 0)
    const updated  = Number(row?.updated  || 0)

    // Auto-tagging: buscar coincidencias con casino_players y agregar tags
    // Sólo si la tabla casino_players existe y hay contactos con casino_username
    const casinoLookups = normalized
      .filter(c => c.casino_username)
      .map(c => c.casino_username!.toLowerCase())

    if (casinoLookups.length > 0) {
      try {
        const casinoInputJson = JSON.stringify(normalized.filter(c => c.casino_username).map(c => ({
          phone: c.phone,
          casino_username: c.casino_username,
        })))

        // Step 1: Clear stale exclusive-family tags for every contact that will be reprocessed.
        // valor_riesgo and antiguedad are current-state classifications — at most one value per
        // family per contact. The DELETE runs first (separate query) so the subsequent INSERT
        // sees a clean slate and ON CONFLICT can never suppress a legitimate new tag value.
        // We do NOT touch casino:monto, casino:actividad, or casino:agente here.
        await query(
          `DELETE FROM contact_tags
           WHERE (tag LIKE 'casino:valor_riesgo:%' OR tag LIKE 'casino:antiguedad:%')
             AND contact_id IN (
               SELECT c.id
               FROM contacts c
               JOIN (
                 SELECT phone, casino_username
                 FROM jsonb_to_recordset($1::jsonb) AS x(phone text, casino_username text)
                 WHERE casino_username IS NOT NULL
               ) inp ON c.phone_number = inp.phone
               JOIN casino_players cp ON cp.username_lower = LOWER(inp.casino_username)
               WHERE cp.seg_monto IS NOT NULL AND cp.seg_actividad IS NOT NULL AND cp.agente IS NOT NULL
             )`,
          [casinoInputJson]
        )

        // Step 2: Insert current tags + set segment.
        //
        // El segmento se calcula igual que en scripts/segmentar-casino-players.js:
        // promedio de cargas sobre los meses CON actividad real. Antes acá se usaba
        // el máximo rolling de 30 días, un criterio distinto con otros umbrales, así
        // que el segmento de un contacto cambiaba según si lo había tocado último el
        // import o el script. Si se ajustan los umbrales, hay que ajustarlos en ambos.
        await query(
          `WITH matched AS (
             SELECT c.id AS contact_id,
                    LOWER(inp.casino_username) AS username_lower,
                    cp.agente, cp.seg_monto, cp.seg_actividad, cp.fecha_primera
             FROM contacts c
             JOIN (
               SELECT phone, casino_username
               FROM jsonb_to_recordset($1::jsonb)
               AS x(phone text, casino_username text)
               WHERE casino_username IS NOT NULL
             ) inp ON c.phone_number = inp.phone
             JOIN casino_players cp ON cp.username_lower = LOWER(inp.casino_username)
             WHERE cp.seg_monto IS NOT NULL AND cp.seg_actividad IS NOT NULL AND cp.agente IS NOT NULL
           ),
           valor AS (
             SELECT m.username_lower AS uname,
                    ROUND(
                      cp.total_cargas::numeric
                      / GREATEST(COUNT(DISTINCT DATE_TRUNC('month', ct.fecha)), 1)
                    ) AS avg_mensual
             FROM matched m
             JOIN casino_players cp ON cp.username_lower = m.username_lower
             LEFT JOIN casino_transactions ct
               ON LOWER(ct.username) = m.username_lower AND ct.tipo = 'carga'
             GROUP BY m.username_lower, cp.total_cargas
           ),
           tags_insert AS (
             INSERT INTO contact_tags (id, contact_id, tag, added_by, added_at)
             SELECT gen_random_uuid(), contact_id,
               unnest(array_remove(ARRAY[
                 'casino:monto:'     || seg_monto,
                 'casino:actividad:' || seg_actividad,
                 'casino:agente:'    || agente,
                 CASE
                   WHEN seg_actividad IN ('perdido','inactivo','en_riesgo') AND seg_monto IN ('super_vip','vip_alto','vip_medio','vip') THEN 'casino:valor_riesgo:critico'
                   WHEN seg_actividad IN ('perdido','inactivo','en_riesgo') AND seg_monto = 'medio'         THEN 'casino:valor_riesgo:medio'
                   WHEN seg_actividad IN ('perdido','inactivo','en_riesgo') AND seg_monto = 'bajo'          THEN 'casino:valor_riesgo:bajo'
                   ELSE NULL
                 END,
                 CASE
                   WHEN fecha_primera IS NULL                              THEN NULL
                   WHEN (CURRENT_DATE - fecha_primera) <  30              THEN 'casino:antiguedad:nuevo'
                   WHEN (CURRENT_DATE - fecha_primera) <  90              THEN 'casino:antiguedad:reciente'
                   WHEN (CURRENT_DATE - fecha_primera) < 150              THEN 'casino:antiguedad:establecido'
                   WHEN (CURRENT_DATE - fecha_primera) < 270              THEN 'casino:antiguedad:veterano'
                   ELSE                                                         'casino:antiguedad:leal'
                 END
               ], NULL)),
               'system', NOW()
             FROM matched
             ON CONFLICT (contact_id, tag) DO NOTHING
           )
           UPDATE contacts
             SET panel      = COALESCE(contacts.panel, m.agente),
                 segment    = CASE
                   WHEN v.avg_mensual >= 3200000 THEN 'super_vip'::contact_segment
                   WHEN v.avg_mensual >= 1500000 THEN 'vip_alto'::contact_segment
                   WHEN v.avg_mensual >= 1000000 THEN 'vip_medio'::contact_segment
                   WHEN v.avg_mensual >=  500000 THEN 'vip'::contact_segment
                   WHEN v.avg_mensual >=  100000 THEN 'medio'::contact_segment
                   WHEN v.avg_mensual IS NOT NULL THEN 'bajo'::contact_segment
                   ELSE m.seg_monto::contact_segment
                 END,
                 updated_at = NOW()
           FROM matched m
           LEFT JOIN valor v ON v.uname = m.username_lower
           WHERE contacts.id = m.contact_id`,
          [casinoInputJson]
        )
      } catch (tagErr) {
        // No fallar el import si el auto-tagging falla (ej: tabla casino_players no existe aún)
        console.warn('[contacts/import] casino auto-tag skipped:', tagErr instanceof Error ? tagErr.message : tagErr)
      }
    }

    // Zeus panel fallback: contacts whose casino_username ends in 'z' that still
    // have no panel. These are Zeus players not yet in the metrics export.
    const zeusPhones = normalized
      .filter(c => c.casino_username && /z$/i.test(c.casino_username))
      .map(c => c.phone)

    if (zeusPhones.length > 0) {
      try {
        await query(
          `UPDATE contacts
           SET panel = 'ofizeus', updated_at = NOW()
           WHERE phone_number = ANY($1::text[])
             AND panel IS NULL`,
          [zeusPhones]
        )
      } catch (zeusErr) {
        console.warn('[contacts/import] zeus fallback skipped:', zeusErr instanceof Error ? zeusErr.message : zeusErr)
      }
    }

    void audit({ req, action: 'import', resource: 'contacts',
      metadata: { inserted, updated, skipped: skipped + invalidCount, invalid: invalidCount, total: contacts.length } })
    return NextResponse.json({ inserted, updated, skipped: skipped + invalidCount, invalid: invalidCount, total: contacts.length })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const code = (e as Record<string, unknown>)?.code
    const detail = (e as Record<string, unknown>)?.detail
    console.error('[contacts/import] bulk upsert error — code:', code, '| detail:', detail, '| msg:', msg)
    return NextResponse.json({ error: `Error al importar: ${msg}` }, { status: 500 })
  }
}
