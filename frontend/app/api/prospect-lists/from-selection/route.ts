import { NextRequest, NextResponse } from 'next/server'
import { query, withTransaction } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { parseBody, handleValidationError, CreateListFromSelectionSchema } from '@/lib/schema'
import { audit } from '@/lib/audit'

// POST /api/prospect-lists/from-selection
// Crea una lista nueva a partir de IDs explícitos o criterios de filtro.
// Los IDs explícitos tienen prioridad sobre los filtros cuando ambos están presentes.
export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lists', 'create')
  if (!auth.ok) return auth.response

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(CreateListFromSelectionSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'prospect-lists')

  const { name, description, prospect_ids, filters } = parsed.data

  try {
    const result = await withTransaction(async (client) => {
      const { rows: listRows } = await client.query<{ id: string }>(
        `INSERT INTO prospect_lists (name, description, created_by)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [name, description || null, auth.user.user_id]
      )
      const list = listRows[0]

      let resolvedIds: string[] = prospect_ids ?? []

      // Si no hay IDs explícitos, resolver mediante filtros
      if (resolvedIds.length === 0 && filters) {
        const { q = '', status, batch_id, opt_in } = filters

        const { rows } = await client.query<{ id: string }>(
          `SELECT p.id
           FROM prospects p
           WHERE ($1 = '' OR p.phone_number ILIKE $1
                          OR p.first_name   ILIKE $1
                          OR p.last_name    ILIKE $1)
             AND ($2::text IS NULL OR p.status = $2)
             AND ($3::uuid IS NULL OR p.import_batch_id = $3)
             AND ($4::boolean IS NULL OR p.opt_in = $4)
             AND p.status = 'active'
             AND p.opt_in = true`,
          [
            q ? `%${q}%` : '',
            status  ?? null,
            batch_id ?? null,
            opt_in  !== undefined ? opt_in : null,
          ]
        )
        resolvedIds = rows.map(r => r.id)
      }

      if (resolvedIds.length === 0) {
        throw new Error('NO_PROSPECTS')
      }

      // Bulk insert — el trigger de member_count se activa por fila
      await client.query(
        `INSERT INTO prospect_list_members (prospect_list_id, prospect_id, added_by)
         SELECT $1, p.id, $3
         FROM prospects p
         WHERE p.id = ANY($2::uuid[])
           AND p.status = 'active'
           AND p.opt_in = true
         ON CONFLICT (prospect_list_id, prospect_id) DO NOTHING`,
        [list.id, resolvedIds, auth.user.user_id]
      )

      const [{ count }] = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM prospect_list_members WHERE prospect_list_id = $1`,
        [list.id]
      ).then(r => r.rows)

      return { id: list.id, member_count: Number(count) }
    })

    void audit({ req, action: 'create', resource: 'prospect-lists', resource_id: result.id,
      metadata: { name, member_count: result.member_count, from_selection: true } })

    return NextResponse.json({ id: result.id, name, member_count: result.member_count }, { status: 201 })
  } catch (e) {
    if (e instanceof Error && e.message === 'NO_PROSPECTS') {
      return NextResponse.json(
        { error: 'No se encontraron prospectos activos con esos criterios' },
        { status: 400 }
      )
    }
    console.error('[POST /api/prospect-lists/from-selection]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
