import { NextRequest, NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { query } from '@/lib/db'
import { MetaCloudApiClient } from '@/lib/cloud-api/client'
import { getTokenForNumber, revokeToken } from '@/lib/cloud-api/token-store'
import { audit } from '@/lib/audit'
import { appLog } from '@/lib/security-log'

// GET  /api/cloud/numbers            — listar todos los números registrados
// GET  /api/cloud/numbers?id=xxx     — detalle de un número
// DELETE /api/cloud/numbers?id=xxx   — desactivar número

export async function GET(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'read')
  if (err) return err

  const id = req.nextUrl.searchParams.get('id')

  if (id) {
    const result = await query(
      `SELECT id, waba_id, phone_number_id, display_phone, verified_name,
              status, coexistence_enabled, contacts_synced, history_synced,
              quality_rating, messaging_limit_tier, whatsapp_line_id,
              onboarded_at, created_at, updated_at
       FROM cloud_numbers WHERE id = $1`,
      [id],
    )
    if (!result[0]) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })
    return NextResponse.json(result[0])
  }

  const result = await query(
    `SELECT id, waba_id, phone_number_id, display_phone, verified_name,
            status, coexistence_enabled, contacts_synced, history_synced,
            quality_rating, messaging_limit_tier, whatsapp_line_id,
            onboarded_at, created_at, updated_at
     FROM cloud_numbers
     ORDER BY created_at DESC`,
  )
  return NextResponse.json(result)
}

// POST /api/cloud/numbers/refresh-quality — actualizar calidad desde Meta

export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err

  let body: { phoneNumberId?: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const { phoneNumberId } = body
  if (!phoneNumberId) return NextResponse.json({ error: 'phoneNumberId requerido' }, { status: 400 })

  try {
    const token = await getTokenForNumber(phoneNumberId)
    const client = new MetaCloudApiClient(token)
    const info = await client.getPhoneNumberInfo(phoneNumberId)

    await query(
      `UPDATE cloud_numbers
       SET quality_rating = $1, verified_name = $2, updated_at = NOW()
       WHERE phone_number_id = $3`,
      [info.quality_rating, info.verified_name, phoneNumberId],
    )

    return NextResponse.json({
      qualityRating:  info.quality_rating,
      verifiedName:   info.verified_name,
      platformType:   info.platform_type,
      throughputLevel: info.throughput.level,
    })
  } catch (err) {
    appLog('ERROR', '[cloud/numbers POST]', { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id requerido' }, { status: 400 })

  const result = await query<{ phone_number_id: string }>(
    `SELECT phone_number_id FROM cloud_numbers WHERE id = $1`,
    [id],
  )
  const row = result[0]
  if (!row) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })

  await revokeToken(row.phone_number_id)

  void audit({
    req,
    action:   'manage',
    resource: 'lines',
    metadata: { action: 'cloud_deactivate', cloudNumberId: id, phoneNumberId: row.phone_number_id },
  })

  return NextResponse.json({ deactivated: true })
}
