import { canReadConversation, conversationPhone } from '@/lib/conversation-access'
import { NextRequest, NextResponse } from 'next/server'
import { reinstateGlobalContact } from '@/lib/global-opt-out'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { normalizePhone, isUUID } from '@/lib/validate'
import { emitUpdate } from '@/lib/sse-events'

type Params = { params: Promise<{ phone: string }> }

// POST — agregar a blacklist
export async function POST(req: NextRequest, { params }: Params) {
  const auth = await checkPermissionWithUser(req, 'blacklist', 'manage')
  if (!auth.ok) return auth.response

  const { phone: rawPhone } = await params
  const phone = conversationPhone(rawPhone)
  const normalized = normalizePhone(phone)
  if (!normalized) return NextResponse.json({ error: 'Teléfono inválido' }, { status: 400 })

  let body: { reason?: string }
  try { body = await req.json() } catch { body = {} }
  const reason  = body.reason?.trim() || 'Manual desde CRM'
  const addedBy = isUUID(auth.user.user_id) ? auth.user.user_id : null

  try {
    if (!await canReadConversation(auth.user, phone)) return NextResponse.json({error: 'Forbidden'}, {status: 403})
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
  const auth = await checkPermissionWithUser(req, 'blacklist', 'manage')
  if (!auth.ok) return auth.response

  const { phone: rawPhone } = await params
  const phone = conversationPhone(rawPhone)
  const normalized = normalizePhone(phone)
  if (!normalized) return NextResponse.json({ error: 'Teléfono inválido' }, { status: 400 })

  const body = await req.json().catch(() => null)
  if (body?.consent_confirmed !== true || typeof body?.consent_note !== 'string' || body.consent_note.trim().length < 10 || body.consent_note.length > 2000) {
    return NextResponse.json({error:'Registrá el nuevo consentimiento desde Blacklist para reactivar el contacto.'},{status:400})
  }
  try {
    if (!await canReadConversation(auth.user, phone)) return NextResponse.json({error:'Forbidden'},{status:403})
    const [entry] = await query<{id:string}>('SELECT id FROM blacklist WHERE phone_number_normalized=$1 AND removed_at IS NULL',[normalized])
    if (!entry || !await reinstateGlobalContact(entry.id,auth.user.user_id,body.consent_note)) return NextResponse.json({error:'Baja no encontrada'},{status:404})
    emitUpdate(phone, 'blacklist')
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[PATCH blacklist]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
