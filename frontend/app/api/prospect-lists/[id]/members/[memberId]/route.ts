import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import { audit } from '@/lib/audit'

// DELETE /api/prospect-lists/[id]/members/[memberId]
// Elimina un miembro de la lista. El trigger de member_count actualiza el contador.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'lists', 'delete')
  if (!auth.ok) return auth.response

  const { id, memberId } = await params
  if (!isUUID(id) || !isUUID(memberId))
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  try {
    const [row] = await query<{ id: string }>(
      `DELETE FROM prospect_list_members
       WHERE id = $1 AND prospect_list_id = $2
       RETURNING id`,
      [memberId, id]
    )
    if (!row) return NextResponse.json({ error: 'Member not found' }, { status: 404 })

    void audit({ req, action: 'delete', resource: 'prospect-list-members', resource_id: memberId,
      metadata: { list_id: id } })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[DELETE /api/prospect-lists/[id]/members/[memberId]]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
