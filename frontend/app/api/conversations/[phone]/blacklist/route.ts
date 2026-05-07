import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { normalizePhone, isUUID } from '@/lib/validate'

type Params = { params: Promise<{ phone: string }> }

// POST /api/conversations/[phone]/blacklist — agrega el número a la blacklist global
export async function POST(req: NextRequest, { params }: Params) {
  const auth = await checkPermissionWithUser(req, 'conversations', 'read')
  if (!auth.ok) return auth.response

  const { phone } = await params
  const normalized = normalizePhone(phone)
  if (!normalized) return NextResponse.json({ error: 'Teléfono inválido' }, { status: 400 })

  let body: { reason?: string }
  try { body = await req.json() } catch { body = {} }
  const reason = body.reason?.trim() || 'Manual desde CRM'

  const addedBy = isUUID(auth.user.user_id) ? auth.user.user_id : null

  try {
    await query(
      `INSERT INTO blacklist (phone_number_raw, phone_number_normalized, reason, source, added_by)
       VALUES ($1, $2, $3, 'manual', $4::UUID)
       ON CONFLICT (phone_number_normalized) WHERE removed_at IS NULL DO NOTHING`,
      [phone, normalized, reason, addedBy]
    )
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[POST /api/conversations/[phone]/blacklist]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
