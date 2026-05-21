import { NextRequest, NextResponse } from 'next/server'
import { query, withTransaction } from '@/lib/db'
import { checkPermissionWithUser, isOwnerOrAdmin } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import { parseBody, handleValidationError, AddProspectListMembersSchema } from '@/lib/schema'
import { audit } from '@/lib/audit'

// POST /api/prospect-lists/[id]/members
// Body: { prospect_ids: string[] }
// Agrega uno o varios prospects a la lista (idempotente vía ON CONFLICT DO NOTHING).
// Filtra automáticamente prospects no activos o sin opt-in.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'lists', 'create')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(AddProspectListMembersSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'prospect-list-members')

  const { prospect_ids } = parsed.data

  try {
    const [list] = await query<{ id: string; owned_by: string | null }>(
      'SELECT id, owned_by FROM prospect_lists WHERE id = $1',
      [id]
    )
    if (!list) return NextResponse.json({ error: 'List not found' }, { status: 404 })
    if (!isOwnerOrAdmin(auth.user, list.owned_by)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Pre-check: ningún prospecto descartado puede entrar a una lista
    const discarded = await query<{ id: string }>(
      `SELECT id FROM prospects WHERE id = ANY($1::uuid[]) AND stage = 'descartado'`,
      [prospect_ids]
    )
    if (discarded.length > 0) {
      return NextResponse.json(
        { error: 'No se puede agregar un prospecto descartado a una lista' },
        { status: 409 }
      )
    }

    const result = await withTransaction(async (client) => {
      // Cuántos de los IDs ya están en la lista antes de insertar
      const { rows: existingRows } = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM prospect_list_members
         WHERE prospect_list_id = $1 AND prospect_id = ANY($2::uuid[])`,
        [id, prospect_ids]
      )
      const already_in = Number(existingRows[0].count)

      // Solo prospects activos, con opt-in y no descartados. Se insertan en bulk.
      // El trigger de member_count se activa por cada fila insertada.
      const { rows: inserted } = await client.query<{ prospect_id: string }>(
        `INSERT INTO prospect_list_members (prospect_list_id, prospect_id, added_by)
         SELECT $1, p.id, $3
         FROM prospects p
         WHERE p.id = ANY($2::uuid[])
           AND p.status = 'active'
           AND p.opt_in = true
           AND (p.stage IS DISTINCT FROM 'descartado')
         ON CONFLICT (prospect_list_id, prospect_id) DO NOTHING
         RETURNING prospect_id`,
        [id, prospect_ids, auth.user.user_id]
      )

      return {
        added:      inserted.length,
        already_in,
        ineligible: prospect_ids.length - already_in - inserted.length,
      }
    })

    void audit({ req, action: 'create', resource: 'prospect-list-members', resource_id: id,
      metadata: { added: result.added, list_id: id } })

    return NextResponse.json(result)
  } catch (e) {
    console.error('[POST /api/prospect-lists/[id]/members]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
