import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'

// POST /api/prospects/bulk-tag
// Body: { tag: string, ids: string[] }
export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'manage')
  if (!auth.ok) return auth.response

  let body: { tag?: string; ids?: string[] }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const tag = (body.tag || '').trim().toLowerCase().slice(0, 100)
  if (!tag) return NextResponse.json({ error: 'tag requerido' }, { status: 400 })
  if (!/^[a-z0-9_\-: ]+$/.test(tag)) return NextResponse.json({ error: 'tag inválido' }, { status: 400 })

  const ids = (body.ids ?? []).filter(isUUID)
  if (!ids.length) return NextResponse.json({ error: 'ids requeridos' }, { status: 400 })

  try {
    const [{ count }] = await query<{ count: string }>(
      `WITH updated AS (
         UPDATE prospects
         SET tags = array_append(COALESCE(tags, '{}'), $1)
         WHERE id = ANY($2::uuid[])
           AND NOT (COALESCE(tags, '{}') @> ARRAY[$1]::text[])
         RETURNING 1
       )
       SELECT COUNT(*)::text AS count FROM updated`,
      [tag, ids]
    )
    return NextResponse.json({ tagged: Number(count) })
  } catch (e) {
    console.error('[prospects/bulk-tag]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
