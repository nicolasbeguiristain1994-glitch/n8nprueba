import { NextRequest, NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { MetaCloudApiClient } from '@/lib/cloud-api/client'
import { getTokenForNumber } from '@/lib/cloud-api/token-store'
import { query } from '@/lib/db'
import { audit } from '@/lib/audit'
import type { CreateTemplateRequest } from '@/lib/cloud-api/types'

// GET  /api/cloud/templates?phoneNumberId=xxx  — listar plantillas del WABA
// POST /api/cloud/templates                    — crear plantilla nueva

export async function GET(req: NextRequest) {
  const err = await checkPermission(req, 'templates', 'read')
  if (err) return err

  const phoneNumberId = req.nextUrl.searchParams.get('phoneNumberId')
  if (!phoneNumberId) return NextResponse.json({ error: 'phoneNumberId requerido' }, { status: 400 })

  const numResult = await query<{ waba_id: string }>(
    `SELECT waba_id FROM cloud_numbers WHERE phone_number_id = $1 AND status = 'active'`,
    [phoneNumberId],
  )
  const row = numResult[0]
  if (!row) return NextResponse.json({ error: 'Número no encontrado' }, { status: 404 })

  try {
    const token    = await getTokenForNumber(phoneNumberId)
    const client   = new MetaCloudApiClient(token)
    const templates = await client.listTemplates(row.waba_id)
    return NextResponse.json(templates)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'templates', 'create')
  if (err) return err

  let body: CreateTemplateRequest & { phoneNumberId?: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const { phoneNumberId, name, category, language, components, wabaId } = body

  if (!phoneNumberId || !name || !category || !language || !components || !wabaId) {
    return NextResponse.json(
      { error: 'Se requieren: phoneNumberId, name, category, language, components, wabaId' },
      { status: 400 },
    )
  }

  // Validar categoría
  if (!['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(category)) {
    return NextResponse.json(
      { error: 'category debe ser UTILITY, MARKETING o AUTHENTICATION' },
      { status: 400 },
    )
  }

  // CRÍTICO: solo enviar plantillas como UTILITY para mensajes transaccionales.
  // MARKETING requiere opt-in explícito y tiene costo mayor.
  if (category === 'MARKETING') {
    console.log('[templates/create] Marketing template creation requested:', name)
  }

  try {
    const token  = await getTokenForNumber(phoneNumberId)
    const client = new MetaCloudApiClient(token)
    const result = await client.createTemplate({ name, category, language, components, wabaId })

    void audit({
      req,
      action:   'create',
      resource: 'templates',
      metadata: { templateName: name, category, language, metaId: result.id },
    })

    return NextResponse.json({ id: result.id, status: result.status }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// DELETE /api/cloud/templates?phoneNumberId=xxx&name=yyy

export async function DELETE(req: NextRequest) {
  const err = await checkPermission(req, 'templates', 'delete')
  if (err) return err

  const phoneNumberId = req.nextUrl.searchParams.get('phoneNumberId')
  const templateName  = req.nextUrl.searchParams.get('name')

  if (!phoneNumberId || !templateName) {
    return NextResponse.json({ error: 'phoneNumberId y name son requeridos' }, { status: 400 })
  }

  const numResult = await query<{ waba_id: string }>(
    `SELECT waba_id FROM cloud_numbers WHERE phone_number_id = $1`,
    [phoneNumberId],
  )
  const row = numResult[0]
  if (!row) return NextResponse.json({ error: 'Número no encontrado' }, { status: 404 })

  try {
    const token  = await getTokenForNumber(phoneNumberId)
    const client = new MetaCloudApiClient(token)
    await client.deleteTemplate(row.waba_id, templateName)

    void audit({
      req,
      action:   'delete',
      resource: 'templates',
      metadata: { templateName, wabaId: row.waba_id },
    })

    return NextResponse.json({ deleted: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
