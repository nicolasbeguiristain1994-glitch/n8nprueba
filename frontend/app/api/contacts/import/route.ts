import { NextRequest, NextResponse } from 'next/server'
import { getLongRunningClient } from '@/lib/db'
import { prepareSegmentation, applySegmentation, activityPreservationPlatforms } from '@/lib/casino-segmentation'
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
  const client = await getLongRunningClient()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL TIME ZONE 'America/Argentina/Buenos_Aires'")
    await client.query("SET LOCAL statement_timeout='60s'")
    await client.query("SELECT pg_advisory_xact_lock(hashtext('casino-segmentation'))")
    const { rows: [row] } = await client.query<{ inserted: string; updated: string; ids: string[] }>(
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
             WHEN NULLIF(casino_username, '') IS NOT NULL
               THEN jsonb_build_array(jsonb_build_object('panel', panel_val, 'username', LOWER(TRIM(casino_username))))
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
               casino_accounts = (SELECT COALESCE(jsonb_agg(DISTINCT account), '[]'::jsonb) FROM jsonb_array_elements(contacts.casino_accounts || EXCLUDED.casino_accounts) account),
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
               casino_accounts = (SELECT COALESCE(jsonb_agg(DISTINCT account), '[]'::jsonb) FROM jsonb_array_elements(contacts.casino_accounts || EXCLUDED.casino_accounts) account),
               linea             = COALESCE(EXCLUDED.linea,      contacts.linea),
               linea_sub         = COALESCE(EXCLUDED.linea_sub,  contacts.linea_sub),
               updated_at        = NOW()`}
         RETURNING id, xmax::text
       )
       SELECT
         COUNT(*) FILTER (WHERE xmax = '0')  AS inserted,
         COUNT(*) FILTER (WHERE xmax != '0') AS updated,
         COALESCE(array_agg(id), '{}'::uuid[]) AS ids
       FROM upserted`,
      [JSON.stringify(normalized), panelValue, lineaValue, JSON.stringify(panelsValue), lineaSubValue]
    )

    const inserted = Number(row?.inserted || 0)
    const updated  = Number(row?.updated  || 0)

    // Only the rows actually inserted/updated are reclassified; skip mode leaves
    // existing contacts untouched. Use exactly the same account links and rules as the CLI.
    if (row.ids.length) {
      await prepareSegmentation(client, { contactIds: row.ids })
      await applySegmentation(client, { updatePlayers: false, preserveActivityPlatforms: activityPreservationPlatforms() })
    }
    await client.query('COMMIT')

    void audit({ req, action: 'import', resource: 'contacts',
      metadata: { inserted, updated, skipped: skipped + invalidCount, invalid: invalidCount, total: contacts.length } })
    return NextResponse.json({ inserted, updated, skipped: skipped + invalidCount, invalid: invalidCount, total: contacts.length })
  } catch (e) {
    await client.query('ROLLBACK')
    const msg = e instanceof Error ? e.message : String(e)
    const code = (e as Record<string, unknown>)?.code
    const detail = (e as Record<string, unknown>)?.detail
    console.error('[contacts/import] bulk upsert error — code:', code, '| detail:', detail, '| msg:', msg)
    return NextResponse.json({ error: 'No se pudo completar la importación y segmentación. No se guardaron cambios.' }, { status: 500 })
  } finally {
    await client.end()
  }
}
