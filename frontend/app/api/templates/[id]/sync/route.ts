import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import { getTemplateStatusFromMeta, mapMetaStatus } from '@/lib/meta-graph'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'settings', 'manage')
  if (!auth.ok) return auth.response
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const rows = await query<{ whatsapp_template_id: string | null }>(
    `SELECT whatsapp_template_id FROM whatsapp_templates WHERE id = $1`, [id]
  )
  if (!rows[0]) return NextResponse.json({ error: 'Plantilla no encontrada' }, { status: 404 })
  if (!rows[0].whatsapp_template_id) {
    return NextResponse.json({ error: 'Esta plantilla no ha sido enviada a Meta todavía' }, { status: 400 })
  }

  try {
    const result = await getTemplateStatusFromMeta(rows[0].whatsapp_template_id)
    const internalStatus = mapMetaStatus(result.status)
    await query(
      `UPDATE whatsapp_templates SET status = $1, rejection_reason = $2, updated_at = NOW() WHERE id = $3`,
      [internalStatus, result.rejection_reason ?? null, id]
    )
    return NextResponse.json({ ok: true, status: internalStatus, rejection_reason: result.rejection_reason })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Error al comunicarse con Meta'
    console.error('[POST /api/templates/[id]/sync]', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
