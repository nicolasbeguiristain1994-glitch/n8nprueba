import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { getAccessibleLineIds } from '@/lib/line-visibility'
import { templateAccountNumber } from '@/lib/template-accounts'
import { TemplateNameSchema } from '@/lib/template-validation'
import { buildLocalTemplateInsert, detectLegacyTemplateColumns } from '@/lib/template-storage'
import { isUUID } from '@/lib/validate'
import { audit } from '@/lib/audit'

const CopySchema = z.object({ waba_id: z.string().regex(/^\d{5,30}$/), name: TemplateNameSchema }).strict()

// Copies content only. Meta IDs, approvals, usage and campaign history stay with the source.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'settings', 'manage')
  if (!auth.ok) return auth.response
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  const input = CopySchema.safeParse(await req.json().catch(() => null))
  if (!input.success) return NextResponse.json({ error: 'Elegí la cuenta de destino y un nombre válido' }, { status: 400 })
  try {
    const ids = await getAccessibleLineIds(auth.user)
    const [source] = await query<{ waba_id: string | null; category: string; language: string; components: unknown[] }>(
      `SELECT waba_id,category,language,components FROM whatsapp_templates WHERE id=$1
        AND (waba_id IS NULL OR $2::uuid[] IS NULL OR EXISTS (
          SELECT 1 FROM cloud_numbers cn WHERE cn.waba_id=whatsapp_templates.waba_id
            AND cn.whatsapp_line_id=ANY($2::uuid[])))`, [id, ids])
    if (!source) return NextResponse.json({ error: 'Plantilla no encontrada' }, { status: 404 })
    if (source.waba_id === input.data.waba_id) return NextResponse.json({ error: 'Elegí una cuenta diferente de la original' }, { status: 400 })
    if (!await templateAccountNumber(auth.user, input.data.waba_id)) return NextResponse.json({ error: 'La cuenta de destino no tiene una línea conectada accesible' }, { status: 403 })
    if (!Array.isArray(source.components)) return NextResponse.json({ error: 'La plantilla no tiene contenido válido para copiar' }, { status: 409 })
    const insert = buildLocalTemplateInsert(await detectLegacyTemplateColumns(query), {
      name: input.data.name, category: source.category, language: source.language,
      components: source.components, createdBy: auth.user.user_id, wabaId: input.data.waba_id,
    })
    const [row] = await query<{ id: string }>(insert.sql, insert.values)
    void audit({ req, action: 'create', resource: 'templates', resource_id: row.id,
      metadata: { action: 'copy_to_account', source_id: id, waba_id: input.data.waba_id } })
    return NextResponse.json({ id: row.id, status: 'BORRADOR' }, { status: 201 })
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return NextResponse.json({ error: 'Ya existe una plantilla con ese nombre e idioma en la cuenta de destino. Cambiá el nombre o usá la existente.' }, { status: 409 })
    return NextResponse.json({ error: 'No se pudo copiar la plantilla' }, { status: 500 })
  }
}
