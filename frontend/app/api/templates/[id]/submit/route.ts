import { NextRequest, NextResponse } from 'next/server'
import { withTransaction } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import { mapMetaStatus, type MetaTemplateStatus } from '@/lib/meta-graph'
import { templateAccountNumber } from '@/lib/template-accounts'
import { getTokenForNumber } from '@/lib/cloud-api/token-store'
import { MetaCloudApiClient } from '@/lib/cloud-api/client'
import { audit } from '@/lib/audit'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'settings', 'manage')
  if (!auth.ok) return auth.response
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  try {
    return await withTransaction(async db => {
      const { rows: [tpl] } = await db.query(`SELECT name,category,language,components,status,waba_id,whatsapp_template_id
        FROM whatsapp_templates WHERE id=$1 FOR UPDATE`, [id])
      if (!tpl) return NextResponse.json({ error: 'Plantilla no encontrada' }, { status: 404 })
      if (!tpl.waba_id) return NextResponse.json({ error: 'Copiá esta plantilla a una cuenta antes de enviarla a Meta' }, { status: 409 })
      const phone = await templateAccountNumber(auth.user, tpl.waba_id)
      if (!phone) return NextResponse.json({ error: 'La cuenta no tiene una línea conectada accesible' }, { status: 403 })
      if (tpl.whatsapp_template_id || tpl.status !== 'BORRADOR') return NextResponse.json({ error: 'Esta plantilla ya fue enviada. Sincronizá su estado desde Meta.' }, { status: 409 })
      const client = new MetaCloudApiClient(await getTokenForNumber(phone))
      // Recover through catalogue sync if a previous Meta success was not persisted locally.
      const existing = (await client.listTemplates(tpl.waba_id)).find(t => t.name === tpl.name && t.language === tpl.language)
      if (existing) return NextResponse.json({ error: 'Ya existe en Meta una plantilla con este nombre e idioma. Sincronizá la cuenta para recuperar su estado.' }, { status: 409 })
      const result = await client.createTemplate({ wabaId: tpl.waba_id, name: tpl.name,
        category: tpl.category, language: tpl.language, components: tpl.components })
      const status = mapMetaStatus(result.status as MetaTemplateStatus)
      await db.query(`UPDATE whatsapp_templates SET whatsapp_template_id=$1,status=$2,rejection_reason=NULL,updated_at=NOW() WHERE id=$3`, [result.id, status, id])
      void audit({ req, action: 'update', resource: 'templates', resource_id: id, metadata: { action: 'submit_to_meta', waba_id: tpl.waba_id } })
      return NextResponse.json({ ok: true, whatsapp_template_id: result.id, status })
    })
  } catch {
    return NextResponse.json({ error: 'No se pudo enviar la plantilla a Meta. Revisá la conexión de la cuenta y los ejemplos del contenido; sincronizá antes de reintentar.' }, { status: 502 })
  }
}
