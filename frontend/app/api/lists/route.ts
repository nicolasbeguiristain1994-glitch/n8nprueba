import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function GET() {
  const lists = await query(`
    SELECT cl.id, cl.name, cl.description, cl.filters, cl.created_at,
           COUNT(clm.contact_id)::int AS contact_count
    FROM contact_lists cl
    LEFT JOIN contact_list_members clm ON clm.list_id = cl.id
    GROUP BY cl.id
    ORDER BY cl.created_at DESC
  `)
  return NextResponse.json({ lists })
}

export async function POST(req: NextRequest) {
  const { name, description, filters, contact_ids, criteria } = await req.json()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })

  const [list] = await query<{ id: string }>(
    `INSERT INTO contact_lists (name, description, filters) VALUES ($1, $2, $3) RETURNING id`,
    [name, description || null, JSON.stringify(filters || criteria || {})]
  )

  let ids: string[] = contact_ids || []

  // Si vienen criterios, resolver los contactos que coinciden
  if (criteria && !contact_ids?.length) {
    const { panel, gaming, segment } = criteria as { panel?: string; gaming?: string; segment?: string }
    const rows = await query<{ id: string }>(
      `SELECT id FROM contacts
       WHERE ($1 = '' OR panel = $1)
         AND ($2 = '' OR gaming::text = $2)
         AND ($3 = '' OR segment::text = $3)`,
      [panel || '', gaming || '', segment || '']
    )
    ids = rows.map(r => r.id)
  }

  for (const cid of ids) {
    await query(
      'INSERT INTO contact_list_members (list_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [list.id, cid]
    )
  }

  return NextResponse.json({ id: list.id, name, total: ids.length })
}
