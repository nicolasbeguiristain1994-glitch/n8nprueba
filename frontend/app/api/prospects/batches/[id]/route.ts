import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'

// DELETE /api/prospects/batches/[id]
// Elimina solo el registro del batch (metadatos). Los prospectos no se tocan.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'manage')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  try {
    const rows = await query<{ id: string }>(
      `DELETE FROM prospect_import_batches WHERE id = $1 RETURNING id`,
      [id]
    )
    if (!rows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ deleted: true })
  } catch (e) {
    console.error('[DELETE /api/prospects/batches/[id]]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
