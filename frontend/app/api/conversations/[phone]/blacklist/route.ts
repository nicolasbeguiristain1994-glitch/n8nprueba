import { canReadConversation, conversationPhone } from '@/lib/conversation-access'
import { NextRequest, NextResponse } from 'next/server'
import { reinstateGlobalContact } from '@/lib/global-opt-out'
import { resolveConsentIdentity } from '@/lib/consent-context'
import { query, withTransaction } from '@/lib/db'
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
    const identity=await resolveConsentIdentity(normalized)
    if(!identity.agent) return NextResponse.json({error:'Este teléfono tiene más de un agente. Elegí la cuenta desde Contactos para bloquear solo ese agente.'},{status:409})
    await withTransaction(async db=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`global-opt-out:${normalized}`])
      await db.query(`INSERT INTO blacklist(phone_number_raw,phone_number_normalized,reason,source,added_by,agent_code,scope_key)
        VALUES($1,$2,$3,'manual',$4::uuid,$5,'agent:'||$5)
        ON CONFLICT(phone_number_normalized,scope_key) WHERE removed_at IS NULL DO NOTHING`,[phone,normalized,reason,addedBy,identity.agent])
    })
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
    const identity=await resolveConsentIdentity(normalized)
    if(!identity.agent) return NextResponse.json({error:'Elegí el agente y registrá el consentimiento desde Blacklist.'},{status:409})
    const [entry] = await query<{id:string}>("SELECT id FROM blacklist WHERE phone_number_normalized=$1 AND agent_code=$2 AND removed_at IS NULL",[normalized,identity.agent])
    if (!entry || !await reinstateGlobalContact(entry.id,auth.user.user_id,body.consent_note)) return NextResponse.json({error:'Baja no encontrada'},{status:404})
    emitUpdate(phone, 'blacklist')
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[PATCH blacklist]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
