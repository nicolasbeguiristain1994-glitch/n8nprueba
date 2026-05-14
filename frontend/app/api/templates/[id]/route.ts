import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import { audit } from '@/lib/audit'
import { parseBody, handleValidationError, UpdateTemplateSchema } from '@/lib/schema'

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

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(UpdateTemplateSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'templates')

  const { name, category, language, components, status, rejection_reason } = parsed.data

  const sets: string[] = ['updated_at = NOW()']
  const vals: unknown[] = []
  let idx = 1

  if (name !== undefined) {
    sets.push(`name = $${idx++}`)
    vals.push(name.trim().toLowerCase().replace(/\s+/g, '_'))
  }
  if (category   !== undefined) { sets.push(`category = $${idx++}`);               vals.push(category) }
  if (language   !== undefined) { sets.push(`language = $${idx++}`);               vals.push(language) }
  if (components !== undefined) { sets.push(`components = $${idx++}::jsonb`);      vals.push(JSON.stringify(components)) }
  if (status     !== undefined) { sets.push(`status = $${idx++}`);                 vals.push(status) }
  if (rejection_reason !== undefined) { sets.push(`rejection_reason = $${idx++}`); vals.push(rejection_reason) }

  vals.push(id)
  try {
    const rows = await query<{ id: string }>(`UPDATE whatsapp_templates SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id`, vals)
    if (!rows[0]) return NextResponse.json({ error: 'Plantilla no encontrada' }, { status: 404 })
    void audit({ req, action: 'update', resource: 'templates', resource_id: id,
      metadata: { fields: Object.keys(parsed.data).filter(k => parsed.data[k as keyof typeof parsed.data] !== undefined) } })
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
    void audit({ req, action: 'delete', resource: 'templates', resource_id: id })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[DELETE /api/templates/[id]]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
