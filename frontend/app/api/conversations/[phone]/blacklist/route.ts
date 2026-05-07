import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { normalizePhone, isUUID } from '@/lib/validate'
import { emitUpdate } from '@/lib/sse-events'

type Params = { params: Promise<{ phone: string }> }

// POST — agregar a blacklist
export async function POST(req: NextRequest, { params }: Params) {
  const auth = await checkPermissionWithUser(req, 'conversations', 'read')
  if (!auth.ok) return auth.response

  const { phone } = await params
  const normalized = normalizePhone(phone)
  if (!normalized) return NextResponse.json({ error: 'Teléfono inválido' }, { status: 400 })

  let body: { reason?: string }
  try { body = await req.json() } catch { body = {} }
  const reason  = body.reason?.trim() || 'Manual desde CRM'
  const addedBy = isUUID(auth.user.user_id) ? auth.user.user_id : null

  try {
    await query(
      `INSERT INTO blacklist (phone_number_raw, phone_number_normalized, reason, source, added_by)
       VALUES ($1, $2, $3, 'manual', $4::UUID)
       ON CONFLICT (phone_number_normalized) WHERE removed_at IS NULL DO NOTHING`,
      [phone, normalized, reason, addedBy]
    )
    emitUpdate(phone, 'blacklist')
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[POST blacklist]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// PATCH — remover de blacklist
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await checkPermissionWithUser(req, 'conversations', 'read')
  if (!auth.ok) return auth.response

  const { phone } = await params
  const normalized = normalizePhone(phone)
  if (!normalized) return NextResponse.json({ error: 'Teléfono inválido' }, { status: 400 })

  const removedBy = isUUID(auth.user.user_id) ? auth.user.user_id : null

  try {
    await query(
      `UPDATE blacklist
       SET removed_at = NOW(), removed_by = $1::UUID
       WHERE phone_number_normalized = $2 AND removed_at IS NULL`,
      [removedBy, normalized]
    )
    emitUpdate(phone, 'blacklist')
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[PATCH blacklist]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
