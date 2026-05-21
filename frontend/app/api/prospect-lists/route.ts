import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { parseBody, handleValidationError, CreateProspectListSchema } from '@/lib/schema'
import { audit } from '@/lib/audit'

/**
 * GET /api/prospect-lists
 *
 * Parámetros opcionales de query:
 *   q          — búsqueda por nombre (ILIKE, default: '')
 *   created_by — UUID del usuario creador; si se envía, filtra solo sus listas
 *   page       — número de página, base 1 (default: 1)
 *   limit      — resultados por página, máx 100 (default: 50)
 *
 * campaign_count se calcula en tiempo real desde la tabla campaigns.
 * member_count se mantiene via trigger y se devuelve tal cual.
 */
export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lists', 'read')
  if (!auth.ok) return auth.response

  const sp         = req.nextUrl.searchParams
  const search     = sp.get('q')          || ''
  const createdBy  = sp.get('created_by') || ''   // UUID o vacío
  const page       = Math.max(1, Number(sp.get('page')  || 1))
  const limit      = Math.min(100, Math.max(1, Number(sp.get('limit') || 50)))
  const offset     = (page - 1) * limit

  // Validación ligera: si llega algo que no es UUID ni vacío, rechazar temprano.
  if (createdBy && !/^[0-9a-f-]{36}$/i.test(createdBy)) {
    return NextResponse.json({ error: 'created_by debe ser un UUID válido' }, { status: 400 })
  }

  try {
    const rows = await query(`
      SELECT
        pl.id, pl.name, pl.description, pl.member_count,
        pl.last_used_at,
        -- Conteo real de campañas que referencian esta lista.
        -- Subquery correlacionada: eficiente para volúmenes normales (< miles de listas).
        (SELECT COUNT(*)::int FROM campaigns c WHERE c.prospect_list_id = pl.id) AS campaign_count,
        pl.created_by, pl.created_at, pl.updated_at
      FROM prospect_lists pl
      WHERE ($1 = '' OR pl.name ILIKE $1)
        AND ($2 = '' OR pl.created_by::text = $2)
      ORDER BY pl.created_at DESC
      LIMIT $3 OFFSET $4
    `, [`%${search}%`, createdBy, limit, offset])

    const [{ count }] = await query<{ count: string }>(
      `SELECT COUNT(*) FROM prospect_lists
       WHERE ($1 = '' OR name ILIKE $1)
         AND ($2 = '' OR created_by::text = $2)`,
      [`%${search}%`, createdBy]
    )

    return NextResponse.json({ lists: rows, total: Number(count), page, limit })
  } catch (e) {
    console.error('[GET /api/prospect-lists]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST /api/prospect-lists  { name, description? }
export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lists', 'create')
  if (!auth.ok) return auth.response

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(CreateProspectListSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'prospect-lists')

  const { name, description } = parsed.data

  try {
    const [row] = await query<{ id: string }>(
      `INSERT INTO prospect_lists (name, description, created_by)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [name, description || null, auth.user.user_id]
    )

    void audit({ req, action: 'create', resource: 'prospect-lists', resource_id: row.id,
      metadata: { name } })

    return NextResponse.json({ id: row.id, name }, { status: 201 })
  } catch (e) {
    console.error('[POST /api/prospect-lists]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
