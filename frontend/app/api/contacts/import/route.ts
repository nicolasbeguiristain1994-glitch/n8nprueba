import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function POST(req: NextRequest) {
  let body: { contacts?: Array<{ phone: string; name?: string; segment?: string }>; panel?: string; gaming?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { contacts, panel, gaming } = body

  if (!contacts?.length) return NextResponse.json({ error: 'No contacts provided' }, { status: 400 })

  const panelValue  = panel?.trim() || null
  const gamingValue = gaming || null
  let inserted = 0, updated = 0, skipped = 0

  for (const c of contacts) {
    const phone = (c.phone || '').toString().trim().replace(/\s/g, '')
    if (!phone) { skipped++; continue }

    try {
      const rows = await query<{ id: string; xmax: string }>(
        `INSERT INTO contacts
           (external_id, phone_number, first_name, segment, panel, gaming, status,
            opt_in_marketing, opt_in_sms, platform_source, created_at, updated_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5::gaming_type, 'active', true, true, 'import', NOW(), NOW())
         ON CONFLICT (phone_number) DO UPDATE
           SET first_name = COALESCE(EXCLUDED.first_name, contacts.first_name),
               segment    = COALESCE(EXCLUDED.segment,    contacts.segment),
               panel      = COALESCE(EXCLUDED.panel,      contacts.panel),
               gaming     = COALESCE(EXCLUDED.gaming,     contacts.gaming),
               updated_at = NOW()
         RETURNING id, xmax::text`,
        [phone, c.name || null, c.segment || null, panelValue, gamingValue]
      )
      if (rows[0]) {
        // xmax = 0 means the row was inserted; non-zero means it was updated
        if (rows[0].xmax === '0') inserted++
        else updated++
      } else {
        skipped++
      }
    } catch (e) {
      console.error('[contacts/import] row error for phone', phone, ':', e instanceof Error ? e.message : e)
      skipped++
    }
  }

  return NextResponse.json({ inserted, updated, skipped, total: contacts.length })
}
