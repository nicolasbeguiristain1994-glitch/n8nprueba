import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function GET() {
  try {
    const lists = await query(`
      SELECT cl.id, cl.name, cl.description, cl.filters, cl.created_at,
             COUNT(clm.contact_id)::int AS contact_count
      FROM contact_lists cl
      LEFT JOIN contact_list_members clm ON clm.list_id = cl.id
      GROUP BY cl.id
      ORDER BY cl.created_at DESC
    `)
    return NextResponse.json({ lists })
  } catch (e) {
    console.error('[/api/lists GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let body: { name?: string; description?: string; filters?: unknown; contact_ids?: string[]; criteria?: { panel?: string; gaming?: string; segment?: string } }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { name, description, filters, contact_ids, criteria } = body
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })

  try {
    const [list] = await query<{ id: string }>(
      `INSERT INTO contact_lists (name, description, filters) VALUES ($1, $2, $3) RETURNING id`,
      [name, description || null, JSON.stringify(filters || criteria || {})]
    )

    let ids: string[] = contact_ids || []

    // Si vienen criterios, resolver los contactos que coinciden
    if (criteria && !contact_ids?.length) {
      const { panel, gaming, segment } = criteria
      const rows = await query<{ id: string }>(
        `SELECT id FROM contacts
         WHERE ($1 = '' OR panel = $1)
           AND ($2 = '' OR gaming::text = $2)
           AND ($3 = '' OR segment::text = $3)`,
        [panel || '', gaming || '', segment || '']
      )
      ids = rows.map(r => r.id)
    }

    // ── Fix 8: bulk insert with unnest instead of per-row loop ──────────────
    if (ids.length > 0) {
      await query(
        `INSERT INTO contact_list_members (list_id, contact_id)
         SELECT $1, unnest($2::uuid[])
         ON CONFLICT DO NOTHING`,
        [list.id, ids]
      )
    }

    return NextResponse.json({ id: list.id, name, total: ids.length })
  } catch (e) {
    console.error('[/api/lists POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
