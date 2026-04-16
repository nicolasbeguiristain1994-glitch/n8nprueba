import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function POST(req: NextRequest) {
  const { contacts, panel, gaming } = await req.json() as {
    contacts: Array<{ phone: string; name?: string; segment?: string }>
    panel?: string
    gaming?: string
  }

  if (!contacts?.length) return NextResponse.json({ error: 'No contacts provided' }, { status: 400 })

  const panelValue  = panel?.trim() || null
  const gamingValue = gaming || null
  let inserted = 0, updated = 0, skipped = 0

  for (const c of contacts) {
    const phone = (c.phone || '').toString().trim().replace(/\s/g, '')
    if (!phone) { skipped++; continue }

    const existing = await query<{ id: string }>('SELECT id FROM contacts WHERE phone_number = $1', [phone])

    if (existing.length > 0) {
      await query(
        `UPDATE contacts
         SET first_name = COALESCE($1, first_name),
             segment    = COALESCE($2, segment),
             panel      = COALESCE($3, panel),
             gaming     = COALESCE($4::gaming_type, gaming),
             updated_at = NOW()
         WHERE phone_number = $5`,
        [c.name || null, c.segment || null, panelValue, gamingValue, phone]
      )
      updated++
    } else {
      try {
        await query(
          `INSERT INTO contacts
             (external_id, phone_number, first_name, segment, panel, gaming, status,
              opt_in_marketing, opt_in_sms, platform_source, created_at, updated_at)
           VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5::gaming_type, 'active', true, true, 'import', NOW(), NOW())`,
          [phone, c.name || null, c.segment || null, panelValue, gamingValue]
        )
        inserted++
      } catch { skipped++ }
    }
  }

  return NextResponse.json({ inserted, updated, skipped, total: contacts.length })
}
