import { NextRequest, NextResponse } from 'next/server'
import { query, withTransaction } from '@/lib/db'
import { isUUID, clampStr } from '@/lib/validate'

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

  const nameStr = clampStr(name, 255)
  if (!nameStr) return NextResponse.json({ error: 'name es requerido y no puede estar vacío' }, { status: 400 })

  if (Array.isArray(contact_ids)) {
    const badUUID = contact_ids.find((id: unknown) => typeof id !== 'string' || !isUUID(id))
    if (badUUID !== undefined) {
      return NextResponse.json({ error: `contact_id inválido: ${badUUID}` }, { status: 400 })
    }
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows: listRows } = await client.query<{ id: string }>(
        `INSERT INTO contact_lists (name, description, filters) VALUES ($1, $2, $3) RETURNING id`,
        [nameStr, description || null, JSON.stringify(filters || criteria || {})]
      )
      const list = listRows[0]

      let ids: string[] = Array.isArray(contact_ids) ? contact_ids : []

      // Si vienen criterios, resolver los contactos que coinciden
      if (criteria && !contact_ids?.length) {
        const { panel, gaming, segment } = criteria as { panel?: string; gaming?: string; segment?: string }
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM contacts
           WHERE ($1 = '' OR panel = $1)
             AND ($2 = '' OR gaming::text = $2)
             AND ($3 = '' OR segment::text = $3)`,
          [panel || '', gaming || '', segment || '']
        )
        ids = rows.map(r => r.id)
      }

      if (ids.length > 0) {
        await client.query(
          `INSERT INTO contact_list_members (list_id, contact_id)
           SELECT $1, unnest($2::uuid[])
           ON CONFLICT DO NOTHING`,
          [list.id, ids]
        )
      }

      return { id: list.id, total: ids.length }
    })

    return NextResponse.json({ id: result.id, name: nameStr, total: result.total })
  } catch (e) {
    console.error('[/api/lists POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
