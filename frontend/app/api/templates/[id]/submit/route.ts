import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import { submitTemplateToMeta, mapMetaStatus } from '@/lib/meta-graph'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'settings', 'manage')
  if (!auth.ok) return auth.response
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const rows = await query<{ name: string; category: string; language: string; components: unknown; status: string }>(
    `SELECT name, category, language, components, status FROM whatsapp_templates WHERE id = $1`, [id]
  )
  if (!rows[0]) return NextResponse.json({ error: 'Plantilla no encontrada' }, { status: 404 })
  const tpl = rows[0]

  try {
    const result = await submitTemplateToMeta({
      name:       tpl.name,
      category:   tpl.category as 'UTILITY' | 'MARKETING' | 'AUTHENTICATION',
      language:   tpl.language,
      components: tpl.components as unknown[],
    })
    const internalStatus = mapMetaStatus(result.status as import('@/lib/meta-graph').MetaTemplateStatus)
    await query(
      `UPDATE whatsapp_templates SET whatsapp_template_id = $1, status = $2, updated_at = NOW() WHERE id = $3`,
      [result.id, internalStatus, id]
    )
    return NextResponse.json({ ok: true, whatsapp_template_id: result.id, status: internalStatus })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Error al comunicarse con Meta'
    console.error('[POST /api/templates/[id]/submit]', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
