import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import { audit } from '@/lib/audit'

const VALID_CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'] as const
const VALID_STATUSES   = ['BORRADOR', 'EN_REVISION', 'APROBADA', 'RECHAZADA', 'DESHABILITADA'] as const

type TemplateRow = {
  id: string; name: string; category: string; language: string; status: string
  components: unknown; whatsapp_template_id: string | null; rejection_reason: string | null
  usage_count: number; last_used_at: string | null; created_by: string | null
  created_at: string; updated_at: string
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'read')
  if (!auth.ok) return auth.response
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  try {
    const [row] = await query<TemplateRow>(
      `SELECT * FROM whatsapp_templates WHERE id = $1`, [id]
    )
    if (!row) return NextResponse.json({ error: 'Plantilla no encontrada' }, { status: 404 })
    return NextResponse.json({ template: row })
  } catch (e) {
    console.error('[GET /api/templates/[id]]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'settings', 'manage')
  if (!auth.ok) return auth.response
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  let body: {
    name?: string; category?: string; language?: string
    components?: unknown[]; status?: string; rejection_reason?: string
  }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const sets: string[] = ['updated_at = NOW()']
  const vals: unknown[] = []
  let idx = 1

  if (body.name !== undefined) {
    sets.push(`name = $${idx++}`)
    vals.push(body.name.trim().toLowerCase().replace(/\s+/g, '_'))
  }
  if (body.category !== undefined) {
    if (!VALID_CATEGORIES.includes(body.category as typeof VALID_CATEGORIES[number])) {
      return NextResponse.json({ error: 'Categoría inválida' }, { status: 400 })
    }
    sets.push(`category = $${idx++}`); vals.push(body.category)
  }
  if (body.language !== undefined) { sets.push(`language = $${idx++}`); vals.push(body.language) }
  if (body.components !== undefined) {
    if (!Array.isArray(body.components)) return NextResponse.json({ error: 'components debe ser array' }, { status: 400 })
    sets.push(`components = $${idx++}::jsonb`); vals.push(JSON.stringify(body.components))
  }
  if (body.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status as typeof VALID_STATUSES[number])) {
      return NextResponse.json({ error: 'Estado inválido' }, { status: 400 })
    }
    sets.push(`status = $${idx++}`); vals.push(body.status)
  }
  if (body.rejection_reason !== undefined) { sets.push(`rejection_reason = $${idx++}`); vals.push(body.rejection_reason) }

  vals.push(id)
  try {
    const rows = await query<{ id: string }>(`UPDATE whatsapp_templates SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id`, vals)
    if (!rows[0]) return NextResponse.json({ error: 'Plantilla no encontrada' }, { status: 404 })
    void audit({ req, action: 'update', resource: 'campaigns', resource_id: id, metadata: { fields: Object.keys(body) } })
    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('unique') || msg.includes('duplicate')) {
      return NextResponse.json({ error: 'Ya existe una plantilla con ese nombre' }, { status: 409 })
    }
    console.error('[PATCH /api/templates/[id]]', msg)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'settings', 'manage')
  if (!auth.ok) return auth.response
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  try {
    const rows = await query<{ id: string }>(`DELETE FROM whatsapp_templates WHERE id = $1 RETURNING id`, [id])
    if (!rows[0]) return NextResponse.json({ error: 'Plantilla no encontrada' }, { status: 404 })
    void audit({ req, action: 'delete', resource: 'campaigns', resource_id: id })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[DELETE /api/templates/[id]]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
