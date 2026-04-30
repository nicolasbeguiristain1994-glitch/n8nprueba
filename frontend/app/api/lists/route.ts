import { NextRequest, NextResponse } from 'next/server'
import { query, withTransaction } from '@/lib/db'
import { isUUID, clampStr } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lists', 'read')
  if (!auth.ok) return auth.response

  const session = auth.user
  const isAdmin = session.role === 'admin'

  try {
    // Admin sees everything (including historical rows where owned_by IS NULL).
    // Operator/viewer see only their own lists; NULL-owned historical lists are
    // admin-only and never appear in non-admin results.
    // Casino predefined lists (source = 'casino') are always excluded from
    // the user-facing view. They exist in DB for segmentation purposes but
    // should not clutter the contacts badges or campaign dropdown.
    const ownerClause = isAdmin
      ? `WHERE COALESCE(cl.source, 'user') != 'casino'`
      : `WHERE cl.owned_by = $1 AND COALESCE(cl.source, 'user') != 'casino'`
    const params = isAdmin ? [] : [session.user_id]

    const lists = await query(`
      SELECT cl.id, cl.name, cl.description, cl.filters, cl.created_at,
             cl.owned_by,
             COUNT(clm.contact_id)::int AS contact_count
      FROM contact_lists cl
      LEFT JOIN contact_list_members clm ON clm.list_id = cl.id
      ${ownerClause}
      GROUP BY cl.id
      ORDER BY cl.created_at DESC
    `, params)
    return NextResponse.json({ lists })
  } catch (e) {
    console.error('[/api/lists GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lists', 'create')
  if (!auth.ok) return auth.response
  const session = auth.user

  let body: {
    name?: string
    description?: string
    filters?: unknown
    contact_ids?: string[]
    criteria?: { panel?: string; gaming?: string; segment?: string; tags?: string[] }
  }
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
        `INSERT INTO contact_lists (name, description, filters, owned_by, updated_by)
         VALUES ($1, $2, $3, $4, $4) RETURNING id`,
        [nameStr, description || null, JSON.stringify(filters || criteria || {}), session.user_id]
      )
      const list = listRows[0]

      let ids: string[] = Array.isArray(contact_ids) ? contact_ids : []

      // Si vienen criterios, resolver los contactos que coinciden
      if (criteria && !contact_ids?.length) {
        const { panel, gaming, segment, tags } = criteria as {
          panel?: string; gaming?: string; segment?: string; tags?: string[]
        }

        if (tags?.length) {
          // Filtrar por tags de casino (contactos que tienen TODOS los tags indicados)
          const { rows } = await client.query<{ id: string }>(
            `SELECT c.id
             FROM contacts c
             WHERE ($1 = '' OR c.panel = $1)
               AND ($2 = '' OR c.gaming::text = $2)
               AND ($3 = '' OR c.segment::text = $3)
               AND NOT EXISTS (
                 -- garantiza que el contacto tiene TODOS los tags requeridos
                 SELECT 1 FROM unnest($4::text[]) AS required_tag
                 WHERE NOT EXISTS (
                   SELECT 1 FROM contact_tags ct
                   WHERE ct.contact_id = c.id AND ct.tag = required_tag
                 )
               )`,
            [panel || '', gaming || '', segment || '', tags]
          )
          ids = rows.map(r => r.id)
        } else {
          const { rows } = await client.query<{ id: string }>(
            `SELECT id FROM contacts
             WHERE ($1 = '' OR panel = $1)
               AND ($2 = '' OR gaming::text = $2)
               AND ($3 = '' OR segment::text = $3)`,
            [panel || '', gaming || '', segment || '']
          )
          ids = rows.map(r => r.id)
        }
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

    void audit({ req, action: 'create', resource: 'lists', resource_id: result.id,
      metadata: { name: nameStr, owner: session.user_id } })
    return NextResponse.json({ id: result.id, name: nameStr, total: result.total })
  } catch (e) {
    console.error('[/api/lists POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
