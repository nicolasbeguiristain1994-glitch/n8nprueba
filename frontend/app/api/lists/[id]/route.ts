import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'lists', 'delete')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const session = auth.user
  const isAdmin = session.role === 'admin'

  try {
    // Verificar que existe y que el usuario tiene permiso para eliminarla
    const rows = await query<{ id: string; owned_by: string | null }>(
      'SELECT id, owned_by FROM contact_lists WHERE id = $1',
      [id],
    )
    if (!rows.length) return NextResponse.json({ error: 'Lista no encontrada' }, { status: 404 })

    const list = rows[0]
    if (!isAdmin && list.owned_by !== session.user_id) {
      return NextResponse.json({ error: 'Sin permiso para eliminar esta lista' }, { status: 403 })
    }

    await query('DELETE FROM contact_list_members WHERE list_id = $1', [id])
    await query('DELETE FROM contact_lists WHERE id = $1', [id])

    void audit({ req, action: 'delete', resource: 'lists', resource_id: id })
    return NextResponse.json({ deleted: true })
  } catch (e) {
    console.error('[/api/lists/[id] DELETE]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
