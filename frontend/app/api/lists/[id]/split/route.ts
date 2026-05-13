import { NextRequest, NextResponse } from 'next/server'
import { query, withTransaction } from '@/lib/db'
import { isUUID, clampStr } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'

// POST /api/lists/[id]/split
//
// Divide una lista en 2 o 3 sublistas de tamaño aproximadamente igual.
// Los contactos se distribuyen aleatoriamente entre las partes.
// La lista original NO se modifica.
//
// Body: { parts: 2 | 3, names?: string[] }
// Respuesta: { lists: [{ id, name, total }] }

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'lists', 'create')
  if (!auth.ok) return auth.response
  const session = auth.user

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  let body: { parts?: unknown; names?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const parts = Number(body.parts)
  if (parts !== 2 && parts !== 3) {
    return NextResponse.json({ error: 'parts debe ser 2 o 3' }, { status: 400 })
  }

  const rawNames = Array.isArray(body.names) ? body.names as unknown[] : []
  const names: string[] = []
  for (let i = 0; i < parts; i++) {
    const n = clampStr(typeof rawNames[i] === 'string' ? rawNames[i] as string : '', 255)
    if (!n) return NextResponse.json({ error: `Falta el nombre para la parte ${i + 1}` }, { status: 400 })
    names.push(n)
  }

  try {
    // Verificar que la lista existe y que el usuario tiene acceso
    const [list] = await query<{ id: string; name: string; owned_by: string | null }>(
      `SELECT id, name, owned_by FROM contact_lists WHERE id = $1`,
      [id],
    )
    if (!list) return NextResponse.json({ error: 'Lista no encontrada' }, { status: 404 })

    const isAdmin = session.role === 'admin'
    if (!isAdmin && list.owned_by !== session.user_id) {
      return NextResponse.json({ error: 'Sin permiso para dividir esta lista' }, { status: 403 })
    }

    // Obtener todos los contact_ids en orden aleatorio
    const members = await query<{ contact_id: string }>(
      `SELECT contact_id FROM contact_list_members WHERE list_id = $1 ORDER BY random()`,
      [id],
    )

    if (members.length === 0) {
      return NextResponse.json({ error: 'La lista no tiene contactos' }, { status: 400 })
    }

    const contactIds = members.map(r => r.contact_id)
    const total = contactIds.length

    // Dividir en partes iguales (la última absorbe el resto)
    const baseSize = Math.floor(total / parts)
    const chunks: string[][] = []
    let offset = 0
    for (let i = 0; i < parts; i++) {
      const size = i < parts - 1 ? baseSize : total - offset
      chunks.push(contactIds.slice(offset, offset + size))
      offset += size
    }

    const created = await withTransaction(async (client) => {
      const result: { id: string; name: string; total: number }[] = []
      for (let i = 0; i < parts; i++) {
        const { rows: listRows } = await client.query<{ id: string }>(
          `INSERT INTO contact_lists (name, owned_by, updated_by)
           VALUES ($1, $2, $2) RETURNING id`,
          [names[i], session.user_id],
        )
        const newId = listRows[0].id
        if (chunks[i].length > 0) {
          await client.query(
            `INSERT INTO contact_list_members (list_id, contact_id)
             SELECT $1, unnest($2::uuid[])
             ON CONFLICT DO NOTHING`,
            [newId, chunks[i]],
          )
        }
        result.push({ id: newId, name: names[i], total: chunks[i].length })
      }
      return result
    })

    void audit({
      req, action: 'create', resource: 'lists',
      metadata: { action: 'split', source_list: id, parts, created: created.map(l => l.id) },
    })

    return NextResponse.json({ lists: created })
  } catch (e) {
    console.error('[/api/lists/[id]/split POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
