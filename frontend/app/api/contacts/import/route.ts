import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isE164 } from '@/lib/validate'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'

export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'contacts', 'create')
  if (err) return err

  let body: { contacts?: Array<{ phone: string; name?: string; segment?: string }>; panel?: string; gaming?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { contacts, panel, gaming } = body
  if (!contacts?.length) return NextResponse.json({ error: 'No contacts provided' }, { status: 400 })
  if (!Array.isArray(contacts) || contacts.length > 5000) {
    return NextResponse.json({ error: 'contacts debe ser un array de máximo 5000 filas' }, { status: 400 })
  }

  const panelValue  = panel?.trim() || null
  const gamingValue = gaming        || null

  // Normalize and pre-filter in JS — count skipped rows before hitting DB
  // Deduplicate phones before SQL; only validate E.164 rows (skip invalid silently)
  const seen = new Set<string>()
  let invalidCount = 0
  const normalized: Array<{ phone: string; name: string | null; segment: string | null }> = []

  for (const c of contacts) {
    const rawPhone = (c.phone || '').toString().trim().replace(/\s/g, '')
    if (!rawPhone) continue
    if (!isE164(rawPhone)) { invalidCount++; continue }
    if (seen.has(rawPhone)) continue
    seen.add(rawPhone)
    normalized.push({
      phone:   rawPhone,
      name:    (c.name    || '').trim() || null,
      segment: (c.segment || '').trim() || null,
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
         SELECT phone, name, segment
         FROM   jsonb_to_recordset($1::jsonb)
                AS x(phone text, name text, segment text)
       ), upserted AS (
         INSERT INTO contacts
           (external_id, phone_number, first_name, segment, panel, gaming, status,
            opt_in_marketing, opt_in_sms, platform_source, created_at, updated_at)
         SELECT
           gen_random_uuid()::text,
           phone,
           NULLIF(name, ''),
           NULLIF(segment, ''),
           $2,
           $3::gaming_type,
           'active', true, true, 'import', NOW(), NOW()
         FROM input
         ON CONFLICT (phone_number) DO UPDATE
           SET first_name = COALESCE(EXCLUDED.first_name, contacts.first_name),
               segment    = COALESCE(EXCLUDED.segment,    contacts.segment),
               panel      = COALESCE(EXCLUDED.panel,      contacts.panel),
               gaming     = COALESCE(EXCLUDED.gaming,     contacts.gaming),
               updated_at = NOW()
         RETURNING id, xmax::text
       )
       SELECT
         COUNT(*) FILTER (WHERE xmax = '0')  AS inserted,
         COUNT(*) FILTER (WHERE xmax != '0') AS updated
       FROM upserted`,
      [JSON.stringify(normalized), panelValue, gamingValue]
    )

    const inserted = Number(row?.inserted || 0)
    const updated  = Number(row?.updated  || 0)
    void audit({ req, action: 'import', resource: 'contacts',
      metadata: { inserted, updated, skipped: skipped + invalidCount, invalid: invalidCount, total: contacts.length } })
    return NextResponse.json({ inserted, updated, skipped: skipped + invalidCount, invalid: invalidCount, total: contacts.length })
  } catch (e) {
    console.error('[contacts/import] bulk upsert error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
