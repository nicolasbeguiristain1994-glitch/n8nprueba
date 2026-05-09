import { NextRequest, NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { triggerSmbSync, getSyncStatus } from '@/lib/cloud-api/coexistence-sync'
import { getTokenForNumber } from '@/lib/cloud-api/token-store'
import { query } from '@/lib/db'
import type { SmbSyncType } from '@/lib/cloud-api/types'

// POST /api/cloud/sync — disparar sincronización manual de Coexistence
// GET  /api/cloud/sync?phoneNumberId=xxx — estado de la sincronización

export async function GET(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'read')
  if (err) return err

  const phoneNumberId = req.nextUrl.searchParams.get('phoneNumberId')
  if (!phoneNumberId) return NextResponse.json({ error: 'phoneNumberId requerido' }, { status: 400 })

  const status = await getSyncStatus(phoneNumberId)
  return NextResponse.json(status)
}

export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err

  let body: { phoneNumberId?: string; syncType?: SmbSyncType; historyDays?: number }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const { phoneNumberId, syncType = 'history', historyDays = 180 } = body
  if (!phoneNumberId) return NextResponse.json({ error: 'phoneNumberId requerido' }, { status: 400 })

  const numberResult = await query<{ waba_id: string }>(
    `SELECT waba_id FROM cloud_numbers WHERE phone_number_id = $1 AND status = 'active'`,
    [phoneNumberId],
  )
  const row = numberResult[0]
  if (!row) return NextResponse.json({ error: 'Número no encontrado o no activo' }, { status: 404 })

  try {
    const accessToken = await getTokenForNumber(phoneNumberId)
    const status = await triggerSmbSync(
      { wabaId: row.waba_id, phoneNumberId, syncType, historyDays },
      accessToken,
    )
    return NextResponse.json(status)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
