import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'

// POST /api/prospects/bulk-tag
// Modo add por IDs:     { tag, mode?: 'add', ids: string[] }
// Modo add por filtros: { tag, mode?: 'add', filters: {...} }
// Modo remove por IDs:  { tag, mode: 'remove', ids: string[] }
// Modo remove por filtros: { tag, mode: 'remove', filters: {...} }
export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'manage')
  if (!auth.ok) return auth.response

  let body: {
    tag?:     string
    mode?:    'add' | 'remove'
    ids?:     string[]
    filters?: { q?: string; status?: string; stage?: string; batch_id?: string; list_id?: string }
  }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const tag = (body.tag || '').trim().toLowerCase().slice(0, 100)
  if (!tag) return NextResponse.json({ error: 'tag requerido' }, { status: 400 })
  if (!/^[a-z0-9_\-: ]+$/.test(tag)) return NextResponse.json({ error: 'tag inválido' }, { status: 400 })

  const mode = body.mode === 'remove' ? 'remove' : 'add'

  // SQL según el modo:
  // add:    array_append + solo actualiza si el tag no existe aún
  // remove: array_remove + solo actualiza si el tag existe
  const tagSql = mode === 'add'
    ? { set: `array_append(COALESCE(tags, '{}'), $1)`,    guard: `NOT (COALESCE(tags, '{}') @> ARRAY[$1]::text[])` }
    : { set: `array_remove(COALESCE(tags, '{}'), $1)`,    guard: `(COALESCE(tags, '{}') @> ARRAY[$1]::text[])` }

  try {
    // ── Modo filtros: "Seleccionar todos" ─────────────────────────────────────
    if (body.filters !== undefined) {
      const f = body.filters
      const conditions: string[] = ['TRUE']
      const params: unknown[] = [tag]
      let p = 2

      if (f.q)        { conditions.push(`(phone_number ILIKE $${p} OR first_name ILIKE $${p} OR last_name ILIKE $${p})`); params.push(`%${f.q}%`); p++ }
      if (f.status)   { conditions.push(`status = $${p++}`);    params.push(f.status) }
      if (f.stage)    { conditions.push(`stage = $${p++}`);     params.push(f.stage) }
      if (f.batch_id && isUUID(f.batch_id)) { conditions.push(`batch_id = $${p++}`); params.push(f.batch_id) }
      if (f.list_id  && isUUID(f.list_id))  {
        conditions.push(`id IN (SELECT prospect_id FROM prospect_list_members WHERE list_id = $${p++}::uuid)`)
        params.push(f.list_id)
      }

      const where = conditions.join(' AND ')
      const [{ count }] = await query<{ count: string }>(
        `WITH updated AS (
           UPDATE prospects
           SET tags = ${tagSql.set}
           WHERE ${where} AND ${tagSql.guard}
           RETURNING 1
         )
         SELECT COUNT(*)::text AS count FROM updated`,
        params,
      )
      return NextResponse.json({ count: Number(count) })
    }

    // ── Modo IDs: selección manual ────────────────────────────────────────────
    const ids = (body.ids ?? []).filter(isUUID)
    if (!ids.length) return NextResponse.json({ error: 'ids o filters requeridos' }, { status: 400 })

    const [{ count }] = await query<{ count: string }>(
      `WITH updated AS (
         UPDATE prospects
         SET tags = ${tagSql.set}
         WHERE id = ANY($2::uuid[]) AND ${tagSql.guard}
         RETURNING 1
       )
       SELECT COUNT(*)::text AS count FROM updated`,
      [tag, ids],
    )
    return NextResponse.json({ count: Number(count) })
  } catch (e) {
    console.error('[prospects/bulk-tag]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
