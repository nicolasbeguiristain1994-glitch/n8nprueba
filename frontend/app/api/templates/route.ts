import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { parseBody, handleValidationError, CreateTemplateSchema } from '@/lib/schema'

type TemplateRow = {
  id: string
  name: string
  category: string
  language: string
  status: string
  components: unknown
  whatsapp_template_id: string | null
  rejection_reason: string | null
  usage_count: number
  last_used_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'read')
  if (!auth.ok) return auth.response

  const status   = req.nextUrl.searchParams.get('status')   || ''
  const category = req.nextUrl.searchParams.get('category') || ''
  const q        = req.nextUrl.searchParams.get('q')        || ''

  try {
    const rows = await query<TemplateRow>(`
      SELECT id, name, category, language, status, components,
             whatsapp_template_id, rejection_reason, usage_count, last_used_at,
             created_by, created_at, updated_at
      FROM whatsapp_templates
      WHERE ($1 = '' OR status = $1)
        AND ($2 = '' OR category = $2)
        AND ($3 = '' OR name ILIKE $3)
      ORDER BY created_at DESC
    `, [status, category, q ? `%${q}%` : ''])
    return NextResponse.json({ templates: rows })
  } catch (e) {
    console.error('[/api/templates GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'settings', 'manage')
  if (!auth.ok) return auth.response

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(CreateTemplateSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'templates')

  const { name, category, language, components } = parsed.data

  // Validar que exista un componente BODY (regla de negocio, no de schema)
  const hasBody = components.some(c => (c as { type?: string }).type === 'BODY')
  if (!hasBody) return NextResponse.json({ error: 'La plantilla debe tener al menos un componente BODY' }, { status: 400 })

  try {
    const [row] = await query<{ id: string }>(
      `INSERT INTO whatsapp_templates (name, category, language, components, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id`,
      [name.trim().toLowerCase().replace(/\s+/g, '_'), category, language, JSON.stringify(components), auth.user.user_id]
    )
    void audit({ req, action: 'create', resource: 'templates', resource_id: row.id,
      metadata: { name, category } })
    return NextResponse.json({ id: row.id }, { status: 201 })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('unique') || msg.includes('duplicate')) {
      return NextResponse.json({ error: 'Ya existe una plantilla con ese nombre' }, { status: 409 })
    }
    console.error('[/api/templates POST]', msg)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
