import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser, isOwnerOrAdmin } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import { audit } from '@/lib/audit'

// GET /api/prospect-lists/[id]?page=1&limit=50&q=search
// Devuelve el detalle de la lista + sus miembros paginados.
// Solo el propietario (owned_by) o un admin pueden acceder.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'lists', 'read')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const sp       = req.nextUrl.searchParams
  const search   = sp.get('q')        || ''
  const download = sp.get('download') === 'true'
  const page     = Math.max(1, Number(sp.get('page')  || 1))
  const limit    = Math.min(200, Math.max(1, Number(sp.get('limit') || 50)))
  const offset   = (page - 1) * limit

  try {
    const [list] = await query(
      `SELECT pl.id, pl.name, pl.description, pl.member_count, pl.last_used_at,
              (SELECT COUNT(*)::int FROM campaigns c WHERE c.prospect_list_id = pl.id) AS campaign_count,
              pl.created_by, pl.owned_by, u.name AS owner_name, pl.created_at, pl.updated_at
       FROM prospect_lists pl
       LEFT JOIN users u ON u.id = pl.owned_by
       WHERE pl.id = $1`,
      [id]
    )
    if (!list) return NextResponse.json({ error: 'List not found' }, { status: 404 })

    // Verificar que el usuario tiene acceso a esta lista específica
    if (!isOwnerOrAdmin(auth.user, (list as { owned_by: string | null }).owned_by)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Modo descarga: devuelve todos los miembros sin paginación en formato ExportableContact
    if (download) {
      const contacts = await query(`
        SELECT
          p.id, p.phone_number, p.first_name, p.last_name, p.email,
          p.opt_in, p.created_at
        FROM prospect_list_members plm
        JOIN prospects p ON p.id = plm.prospect_id
        WHERE plm.prospect_list_id = $1
        ORDER BY plm.added_at DESC
      `, [id])
      return NextResponse.json({ contacts })
    }

    const members = await query(`
      SELECT
        plm.id, plm.prospect_list_id, plm.prospect_id,
        plm.added_at, plm.added_by,
        p.phone_number, p.first_name, p.last_name, p.email,
        p.status, p.stage, p.opt_in
      FROM prospect_list_members plm
      JOIN prospects p ON p.id = plm.prospect_id
      WHERE plm.prospect_list_id = $1
        AND ($2 = '' OR p.phone_number ILIKE $2
                     OR p.first_name   ILIKE $2
                     OR p.last_name    ILIKE $2)
      ORDER BY plm.added_at DESC
      LIMIT $3 OFFSET $4
    `, [id, `%${search}%`, limit, offset])

    const [{ count }] = await query<{ count: string }>(`
      SELECT COUNT(*) FROM prospect_list_members plm
      JOIN prospects p ON p.id = plm.prospect_id
      WHERE plm.prospect_list_id = $1
        AND ($2 = '' OR p.phone_number ILIKE $2
                     OR p.first_name   ILIKE $2
                     OR p.last_name    ILIKE $2)
    `, [id, `%${search}%`])

    return NextResponse.json({ list, members, total: Number(count), page, limit })
  } catch (e) {
    console.error('[GET /api/prospect-lists/[id]]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// DELETE /api/prospect-lists/[id]
// Solo el propietario (owned_by) o un admin pueden eliminar la lista.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'lists', 'delete')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  try {
    const [existing] = await query<{ owned_by: string | null }>(
      `SELECT owned_by FROM prospect_lists WHERE id = $1`,
      [id]
    )
    if (!existing) return NextResponse.json({ error: 'List not found' }, { status: 404 })

    if (!isOwnerOrAdmin(auth.user, existing.owned_by)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const [row] = await query<{ id: string; name: string }>(
      `DELETE FROM prospect_lists WHERE id = $1 RETURNING id, name`,
      [id]
    )
    if (!row) return NextResponse.json({ error: 'List not found' }, { status: 404 })

    void audit({ req, action: 'delete', resource: 'prospect-lists', resource_id: id,
      metadata: { name: row.name } })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[DELETE /api/prospect-lists/[id]]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
