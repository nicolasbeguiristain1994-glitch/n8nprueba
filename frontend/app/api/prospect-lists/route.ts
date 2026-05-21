import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { parseBody, handleValidationError, CreateProspectListSchema } from '@/lib/schema'
import { audit } from '@/lib/audit'

/**
 * GET /api/prospect-lists
 *
 * Visibilidad (igual que /api/lists → contact_lists):
 *   Admin        → ve todas las listas (incluyendo owned_by IS NULL).
 *   Operador/Viewer → solo ve las listas donde owned_by = session.user_id.
 *   Las listas sin dueño (owned_by IS NULL) son solo visibles para admins.
 *
 * Parámetros opcionales de query:
 *   q     — búsqueda por nombre (ILIKE, default: '')
 *   page  — número de página, base 1 (default: 1)
 *   limit — resultados por página, máx 100 (default: 50)
 *
 * campaign_count se calcula en tiempo real desde la tabla campaigns.
 * member_count se mantiene via trigger y se devuelve tal cual.
 */
export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lists', 'read')
  if (!auth.ok) return auth.response

  const { user } = auth
  const isAdmin = user.role === 'admin'

  const sp     = req.nextUrl.searchParams
  const search = sp.get('q')    || ''
  const page   = Math.max(1, Number(sp.get('page')  || 1))
  const limit  = Math.min(100, Math.max(1, Number(sp.get('limit') || 50)))
  const offset = (page - 1) * limit

  // Cláusula de visibilidad — espejo exacto de /api/lists.
  // Para admins, ownerParam = null hace que `$2 IS NULL` sea TRUE (sin filtro).
  // Para no-admins, ownerParam = user_id fuerza `pl.owned_by = $2`.
  // Las listas con owned_by IS NULL (usuario eliminado) son invisibles para no-admins
  // porque owned_by != user_id, coherente con el comportamiento de contact_lists.
  const ownerClause = `AND ($2::uuid IS NULL OR pl.owned_by = $2::uuid)`
  const ownerParam: string | null = isAdmin ? null : user.user_id

  try {
    const rows = await query(`
      SELECT
        pl.id, pl.name, pl.description, pl.member_count,
        pl.last_used_at,
        (SELECT COUNT(*)::int FROM campaigns c WHERE c.prospect_list_id = pl.id) AS campaign_count,
        pl.created_by, pl.owned_by,
        u.name AS owner_name,
        pl.created_at, pl.updated_at
      FROM prospect_lists pl
      LEFT JOIN users u ON u.id = pl.owned_by
      WHERE ($1 = '' OR pl.name ILIKE $1)
        ${ownerClause}
      ORDER BY pl.created_at DESC
      LIMIT $3 OFFSET $4
    `, [`%${search}%`, ownerParam, limit, offset])

    const [{ count }] = await query<{ count: string }>(
      `SELECT COUNT(*) FROM prospect_lists pl
       WHERE ($1 = '' OR pl.name ILIKE $1)
         ${ownerClause}`,
      [`%${search}%`, ownerParam]
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
      `INSERT INTO prospect_lists (name, description, created_by, owned_by)
       VALUES ($1, $2, $3, $3)
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
