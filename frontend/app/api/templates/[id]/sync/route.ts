import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import { mapMetaStatus } from '@/lib/meta-graph'
import { templateAccountNumber } from '@/lib/template-accounts'
import { getTokenForNumber } from '@/lib/cloud-api/token-store'
import { MetaCloudApiClient } from '@/lib/cloud-api/client'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'settings', 'manage')
  if (!auth.ok) return auth.response
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  try {
    const [tpl] = await query<{ whatsapp_template_id: string | null; waba_id: string | null }>(
      'SELECT whatsapp_template_id,waba_id FROM whatsapp_templates WHERE id=$1', [id])
    if (!tpl) return NextResponse.json({ error: 'Plantilla no encontrada' }, { status: 404 })
    if (!tpl.waba_id) return NextResponse.json({ error: 'Esta plantilla no tiene una cuenta asociada. Sincronizá la cuenta para importar su aprobación.' }, { status: 409 })
    const phone = await templateAccountNumber(auth.user, tpl.waba_id)
    if (!phone) return NextResponse.json({ error: 'La cuenta no tiene una línea conectada accesible' }, { status: 403 })
    if (!tpl.whatsapp_template_id) return NextResponse.json({ error: 'La plantilla todavía no fue enviada a Meta' }, { status: 400 })
    const client = new MetaCloudApiClient(await getTokenForNumber(phone))
    const result = (await client.listTemplates(tpl.waba_id)).find(t => t.id === tpl.whatsapp_template_id)
    const status = result ? mapMetaStatus(result.status) : 'DESHABILITADA'
    await query('UPDATE whatsapp_templates SET status=$1,rejection_reason=$2,updated_at=NOW() WHERE id=$3',
      [status, result?.rejected_reason ?? null, id])
    return NextResponse.json({ ok: true, status })
  } catch {
    return NextResponse.json({ error: 'No se pudo actualizar el estado desde Meta. El estado anterior se conservó.' }, { status: 502 })
  }
}
