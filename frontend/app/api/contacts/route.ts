import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function GET(req: NextRequest) {
  const search  = req.nextUrl.searchParams.get('q') || ''
  const segment = req.nextUrl.searchParams.get('segment') || ''
  const gaming  = req.nextUrl.searchParams.get('gaming') || ''
  const panel   = req.nextUrl.searchParams.get('panel') || ''
  const download = req.nextUrl.searchParams.get('download') === 'true'
  const page    = Number(req.nextUrl.searchParams.get('page') || 1)
  const limit   = download ? 100000 : 50
  const offset  = download ? 0 : (page - 1) * limit
  const linea   = req.nextUrl.searchParams.get('linea') || ''

  try {
    const rows = await query(`
      SELECT id, phone_number, first_name, last_name, email,
             status, opt_in_marketing AS opt_in, created_at, segment, panel, gaming::text AS gaming, linea
      FROM contacts
      WHERE ($1 = '' OR phone_number ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1)
        AND ($4 = '' OR segment::text = $4)
        AND ($5 = '' OR gaming::text = $5)
        AND ($6 = '' OR panel = $6)
        AND ($7 = '' OR linea::text = $7)
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [`%${search}%`, limit, offset, segment, gaming, panel, linea])

    const [{ count }] = await query<{ count: string }>(
      `SELECT COUNT(*) FROM contacts
       WHERE ($1 = '' OR phone_number ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1)
         AND ($2 = '' OR segment::text = $2)
         AND ($3 = '' OR gaming::text = $3)
         AND ($4 = '' OR panel = $4)
         AND ($5 = '' OR linea::text = $5)`,
      [`%${search}%`, segment, gaming, panel, linea]
    )

    return NextResponse.json({ contacts: rows, total: Number(count), page, limit })
  } catch (e) {
    console.error('[/api/contacts GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let body: { phone?: string; name?: string; panel?: string; gaming?: string; segment?: string; linea?: string | number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { phone, name, panel, gaming, segment, linea } = body
  const phone_clean = (phone || '').toString().trim().replace(/\s/g, '')
  if (!phone_clean) return NextResponse.json({ error: 'Teléfono requerido' }, { status: 400 })

  try {
    const existing = await query<{ id: string }>('SELECT id FROM contacts WHERE phone_number = $1', [phone_clean])
    if (existing.length > 0) return NextResponse.json({ error: 'Ya existe un contacto con ese teléfono' }, { status: 409 })

    const nameParts = (name || '').trim().split(' ')
    const first_name = nameParts[0] || null
    const last_name  = nameParts.slice(1).join(' ') || null

    const lineaVal = linea ? Number(linea) : null
    const [row] = await query<{ id: string }>(
      `INSERT INTO contacts
         (external_id, phone_number, first_name, last_name, segment, panel, gaming, linea, status,
          opt_in_marketing, opt_in_sms, platform_source, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4::contact_segment, $5, $6::gaming_type, $7, 'active', true, true, 'manual', NOW(), NOW())
       RETURNING id`,
      [phone_clean, first_name, last_name, segment || null, panel || null, gaming || null, lineaVal]
    )
    return NextResponse.json({ id: row.id })
  } catch (e: unknown) {
    console.error('[/api/contacts POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
