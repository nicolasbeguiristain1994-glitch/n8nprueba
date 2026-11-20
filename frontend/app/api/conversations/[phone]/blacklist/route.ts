import { canReadConversation, conversationPhone } from '@/lib/conversation-access'
import { NextRequest, NextResponse } from 'next/server'
import { reinstateGlobalContact } from '@/lib/global-opt-out'
import { resolveConsentIdentity } from '@/lib/consent-context'
import { query, withTransaction } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { normalizePhone, isUUID } from '@/lib/validate'
import { canonicalContactAgent } from '@/lib/contact-account-identity'
import { audit } from '@/lib/audit'
import { emitUpdate } from '@/lib/sse-events'
import type { BlacklistEntry } from '@/lib/blacklist-entry'

type Params = { params: Promise<{ phone: string }> }

// Only blacklist managers can inspect or lift the individual blocks of a phone.
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await checkPermissionWithUser(req, 'blacklist', 'manage')
  if (!auth.ok) return auth.response
  const phone = conversationPhone((await params).phone)
  const normalized = normalizePhone(phone)
  if (!normalized) return NextResponse.json({ error: 'Teléfono inválido' }, { status: 400 })
  try {
    if (!await canReadConversation(auth.user, phone)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const entries = await query<BlacklistEntry>(`SELECT id,scope_key,agent_code,reason,
      COALESCE(
        (SELECT l.display_name FROM whatsapp_lines l JOIN cloud_numbers n ON n.whatsapp_line_id=l.id
          WHERE bl.scope_key='source:cloud:'||n.phone_number_id LIMIT 1),
        (SELECT l.display_name FROM whatsapp_lines l
          WHERE bl.scope_key='source:evolution:'||l.evolution_instance LIMIT 1)
      ) AS line_name
      FROM blacklist bl WHERE phone_number_normalized=$1 AND removed_at IS NULL
      ORDER BY added_at,id`, [normalized])
    return NextResponse.json({ entries }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    console.error('[GET conversation blacklist]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'No se pudieron consultar los bloqueos.' }, { status: 500 })
  }
}

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
    return NextResponse.json({error:'Confirmá la reactivación y registrá cómo lo pidió el contacto (10 a 2000 caracteres).'},{status:400})
  }
  try {
    if (!await canReadConversation(auth.user, phone)) return NextResponse.json({error:'Forbidden'},{status:403})
    // The dialog selects an exact entry, including agentless and global blocks.
    // Bind it to this phone; never infer or remove another scope alongside it.
    if (body.entry_id !== undefined) {
      if (typeof body.entry_id !== 'string' || !isUUID(body.entry_id)) return NextResponse.json({error:'Bloqueo inválido'}, {status:400})
      const [entry] = await query<Pick<BlacklistEntry, 'id' | 'scope_key' | 'agent_code'>>(
        `SELECT id,scope_key,agent_code FROM blacklist
          WHERE id=$1::uuid AND phone_number_normalized=$2 AND removed_at IS NULL`, [body.entry_id, normalized])
      if (!entry || !await reinstateGlobalContact(entry.id, auth.user.user_id, body.consent_note)) {
        return NextResponse.json({error:'Esta baja ya no está activa. Actualizá la conversación.'}, {status:404})
      }
      void audit({req,action:'delete',resource:'blacklist',resource_id:entry.id,
        metadata:{scope:entry.scope_key,agent_code:entry.agent_code,source:'conversation'}})
      emitUpdate(phone, 'blacklist')
      return NextResponse.json({ok:true,entry_id:entry.id})
    }
    // Explicit agent comes from the open conversation. Admin permission and an
    // exact active blacklist entry are required; never remove other scopes.
    if (body.agent_code !== undefined && (typeof body.agent_code !== 'string' ||
        !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(body.agent_code))) {
      return NextResponse.json({error:'Agente inválido'}, {status:400})
    }
    const agent = body.agent_code !== undefined ? canonicalContactAgent(body.agent_code)
      : (await resolveConsentIdentity(normalized)).agent
    if (!agent) return NextResponse.json({error:'Elegí el agente del contacto para reactivarlo.'}, {status:409})
    const entries = await query<{id:string;scope_key:string}>(`SELECT id,scope_key FROM blacklist
      WHERE phone_number_normalized=$1 AND removed_at IS NULL
      AND (scope_key='global' OR (agent_code=$2 AND scope_key='agent:'||$2))`,[normalized,agent])
    if (entries.some(entry => entry.scope_key === 'global')) {
      return NextResponse.json({error:'Este número tiene un bloqueo global. Revisalo desde Blacklist antes de reactivarlo.'}, {status:409})
    }
    const entry = entries.find(entry => entry.scope_key === 'agent:'+agent)
    if (!entry || !await reinstateGlobalContact(entry.id,auth.user.user_id,body.consent_note)) {
      return NextResponse.json({error:'No hay una baja activa para este agente. Actualizá la conversación.'},{status:404})
    }
    void audit({req,action:'delete',resource:'blacklist',resource_id:entry.id,
      metadata:{scope:'agent',agent_code:agent,source:'conversation'}})
    emitUpdate(phone, 'blacklist')
    return NextResponse.json({ ok: true, agent_code: agent })
  } catch (e) {
    console.error('[PATCH blacklist]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
