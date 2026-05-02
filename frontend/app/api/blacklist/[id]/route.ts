import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import { audit } from '@/lib/audit'

// ── DELETE /api/blacklist/[id] — Soft-delete (quitar de blacklist) ─────────────

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'blacklist', 'manage')
  if (!auth.ok) return auth.response
  const session = auth.user

  const { id } = await params

  if (!isUUID(id)) {
    return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  }

  try {
    const rows = await query<{ id: string; phone_number_normalized: string }>(
      `UPDATE blacklist
       SET removed_at = NOW(), removed_by = $2
       WHERE id = $1 AND removed_at IS NULL
       RETURNING id, phone_number_normalized`,
      [id, session.user_id],
    )

    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'Registro no encontrado o ya fue removido' },
        { status: 404 },
      )
    }

    void audit({
      req,
      action: 'delete',
      resource: 'blacklist',
      resource_id: id,
      metadata: { phone_number_normalized: rows[0].phone_number_normalized },
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/blacklist/[id] DELETE]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
