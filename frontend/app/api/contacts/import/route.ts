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
    linea?:         number
    skip_existing?: boolean
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { contacts, panel, linea, skip_existing = false } = body
  if (!contacts?.length) return NextResponse.json({ error: 'No contacts provided' }, { status: 400 })
  if (!Array.isArray(contacts) || contacts.length > 10_000) {
    return NextResponse.json({ error: 'contacts debe ser un array de máximo 10.000 filas por chunk' }, { status: 400 })
  }

  const panelValue = panel?.trim() || null
  const lineaValue = linea ? Number(linea) : null
  if (lineaValue !== null && (lineaValue < 1 || lineaValue > 100)) {
    return NextResponse.json({ error: 'Línea inválida (1-100)' }, { status: 400 })
  }

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
    const VALID_SEGMENTS = ['casual', 'regular', 'super_vip', 'vip', 'whale', 'bajo', 'medio']
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
         SELECT phone, name, segment, casino_username
         FROM   jsonb_to_recordset($1::jsonb)
                AS x(phone text, name text, segment text, casino_username text)
       ), upserted AS (
         INSERT INTO contacts
           (external_id, phone_number, first_name, segment, panel, linea, status,
            opt_in_marketing, opt_in_sms, platform_source, created_at, updated_at)
         SELECT
           gen_random_uuid()::text,
           phone,
           NULLIF(name, ''),
           NULLIF(segment, '')::contact_segment,
           $2,
           $3,
           'active', true, true, 'import', NOW(), NOW()
         FROM input
         ON CONFLICT (phone_number) DO ${ skip_existing ? 'NOTHING' : `UPDATE
           SET first_name = COALESCE(EXCLUDED.first_name, contacts.first_name),
               segment    = COALESCE(EXCLUDED.segment,    contacts.segment),
               panel      = COALESCE(EXCLUDED.panel,      contacts.panel),
               linea      = COALESCE(EXCLUDED.linea,      contacts.linea),
               updated_at = NOW()`}
         RETURNING id, xmax::text
       )
       SELECT
         COUNT(*) FILTER (WHERE xmax = '0')  AS inserted,
         COUNT(*) FILTER (WHERE xmax != '0') AS updated
       FROM upserted`,
      [JSON.stringify(normalized), panelValue, lineaValue]
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

        // Step 2: Insert current tags + set segment based on 30-day rolling deposit volume.
        // Super Vip (vip)  = max 30-day deposits >= $1,000,000 in any period
        // Vip       (alto) = max 30-day deposits >= $500,000   in any period
        // Otherwise        = use casino's seg_monto as fallback
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
           rolling AS (
             SELECT LOWER(t.username) AS uname, MAX(t.window_sum) AS max_30d
             FROM (
               SELECT username,
                      SUM(monto) OVER (
                        PARTITION BY LOWER(username)
                        ORDER BY fecha
                        RANGE BETWEEN INTERVAL '30 days' PRECEDING AND CURRENT ROW
                      ) AS window_sum
               FROM casino_transactions
               WHERE tipo = 'carga'
                 AND LOWER(username) IN (SELECT username_lower FROM matched)
             ) t
             GROUP BY LOWER(t.username)
           ),
           tags_insert AS (
             INSERT INTO contact_tags (id, contact_id, tag, added_by, added_at)
             SELECT gen_random_uuid(), contact_id,
               unnest(array_remove(ARRAY[
                 'casino:monto:'     || seg_monto,
                 'casino:actividad:' || seg_actividad,
                 'casino:agente:'    || agente,
                 CASE
                   WHEN seg_actividad IN ('perdido','inactivo','en_riesgo') AND seg_monto IN ('super_vip','vip') THEN 'casino:valor_riesgo:critico'
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
                   WHEN COALESCE(r.max_30d, 0) >= 1000000 THEN 'super_vip'::contact_segment
                   WHEN COALESCE(r.max_30d, 0) >= 500000  THEN 'vip'::contact_segment
                   WHEN r.max_30d IS NOT NULL AND m.seg_monto IN ('super_vip','vip') THEN 'medio'::contact_segment
                   ELSE m.seg_monto::contact_segment
                 END,
                 updated_at = NOW()
           FROM matched m
           LEFT JOIN rolling r ON r.uname = m.username_lower
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
