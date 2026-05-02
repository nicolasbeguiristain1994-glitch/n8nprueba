import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import { audit } from '@/lib/audit'

// ── POST /api/automations/[id]/toggle ────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'automations' as never, 'manage')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  try {
    const rows = await query<{ id: string; is_active: boolean; name: string }>(
      `UPDATE automations
       SET is_active = NOT is_active, updated_at = NOW()
       WHERE id = $1
       RETURNING id, is_active, name`,
      [id],
    )
    if (!rows[0]) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })

    void audit({ req, action: 'update', resource: 'automations' as never, resource_id: id,
      metadata: { toggled_to: rows[0].is_active ? 'active' : 'paused' } })

    return NextResponse.json({ id, is_active: rows[0].is_active })
  } catch (e) {
    console.error('[/api/automations/[id]/toggle]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
