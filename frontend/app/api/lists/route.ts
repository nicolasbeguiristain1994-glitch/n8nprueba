import { resolveSavedAudience, savedAudienceParams } from '@/lib/dynamic-audiences'
import { ContactFilterError } from '@/lib/contact-filters'
import { contactScope } from '@/lib/contact-visibility'
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

    const scope = contactScope(session, params.length, 'c')
    const lists = await query(`
      SELECT cl.id, cl.name, cl.description, cl.filters, cl.created_at, cl.is_dynamic, cl.refreshed_at,
             cl.owned_by,
             COUNT(c.id)::int AS contact_count
      FROM contact_lists cl
      LEFT JOIN contact_list_members clm ON clm.list_id = cl.id
      LEFT JOIN contacts c ON c.id=clm.contact_id AND ${scope.sql}
      ${ownerClause}
      GROUP BY cl.id
      ORDER BY cl.created_at DESC
    `, [...params, ...scope.params])
    return NextResponse.json({ lists })
  } catch (e) {
    if (e instanceof Response) return e
    if (e instanceof ContactFilterError) return NextResponse.json({error:e.message},{status:400})
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
    is_dynamic?: boolean
    filters?: unknown
    contact_ids?: string[]
    criteria?: { panel?: string; gaming?: string; segment?: string; tags?: string[] }
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { name, description, filters, contact_ids, criteria, is_dynamic } = body

  if(is_dynamic!==undefined && typeof is_dynamic!=='boolean') return NextResponse.json({error:'Tipo de lista inválido'},{status:400})
  const nameStr = clampStr(name, 255)
  if (!nameStr) return NextResponse.json({ error: 'name es requerido y no puede estar vacío' }, { status: 400 })

  if (Array.isArray(contact_ids)) {
    const badUUID = contact_ids.find((id: unknown) => typeof id !== 'string' || !isUUID(id))
    if (badUUID !== undefined) {
      return NextResponse.json({ error: `contact_id inválido: ${badUUID}` }, { status: 400 })
    }
  }

  try {
    if (is_dynamic && (contact_ids || criteria)) throw new ContactFilterError('Una lista dinámica usa los filtros actuales, no una selección fija')
    const dynamicFilters = is_dynamic ? Object.fromEntries(savedAudienceParams(filters)) : null
    const dynamicIds = is_dynamic ? await resolveSavedAudience(dynamicFilters, session) : null
    let criteriaIds: string[] | null = null
    if (criteria && !contact_ids?.length) {
      const shared: Record<string,string> = {panel:criteria.panel||'',gaming:criteria.gaming||'',segment:criteria.segment||''}
      for (const tag of criteria.tags||[]) {
        const match=/^casino:(actividad|antiguedad):([a-z_]+)$/.exec(tag)
        if (!match) throw new ContactFilterError('Criterio de segmentación inválido')
        shared[match[1]]=[shared[match[1]],match[2]].filter(Boolean).join(',')
      }
      criteriaIds=await resolveSavedAudience(shared,session)
    }
    const result = await withTransaction(async (client) => {
      const { rows: listRows } = await client.query<{ id: string }>(
        `INSERT INTO contact_lists (name, description, filters, owned_by, updated_by, is_dynamic, refreshed_at)
         VALUES ($1, $2, $3, $4, $4, $5, NOW()) RETURNING id`,
        [nameStr, description || null, JSON.stringify(dynamicFilters || filters || criteria || {}), session.user_id, is_dynamic===true]
      )
      const list = listRows[0]

      let ids: string[] = dynamicIds ?? criteriaIds ?? (Array.isArray(contact_ids) ? contact_ids : [])

      ids = [...new Set(ids)]
      if (ids.length > 0) {
        const scope = contactScope(session, 2)
        const inserted = await client.query(
          `INSERT INTO contact_list_members (list_id, contact_id)
           SELECT $1, id FROM contacts WHERE id=ANY($2::uuid[]) AND ${scope.sql}
           ON CONFLICT DO NOTHING RETURNING contact_id`,
          [list.id, ids, ...scope.params]
        )
        if (inserted.rows.length !== ids.length) throw NextResponse.json({error: 'La selección incluye contactos fuera de tu alcance'}, {status: 403})
      }

      return { id: list.id, total: ids.length }
    })

    void audit({ req, action: 'create', resource: 'lists', resource_id: result.id,
      metadata: { name: nameStr, owner: session.user_id } })
    return NextResponse.json({ id: result.id, name: nameStr, total: result.total })
  } catch (e) {
    if (e instanceof Response) return e
    if (e instanceof ContactFilterError) return NextResponse.json({error:e.message},{status:400})
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[/api/lists POST]', msg)
    if (msg.includes('contact_lists_name_unique')) {
      return NextResponse.json({ error: 'Ya existe una lista con ese nombre. Usá un nombre diferente.' }, { status: 409 })
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
