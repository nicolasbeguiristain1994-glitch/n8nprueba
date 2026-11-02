import { requireConversation, conversationPhone } from '@/lib/conversation-access'
import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { emitUpdate } from '@/lib/sse-events'

type Params = { params: Promise<{ phone: string }> }

// PATCH /api/conversations/[phone]/status — actualiza current_flow de la conversación
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await checkPermissionWithUser(req, 'conversations', 'update')
  if (!auth.ok) return auth.response

  const { phone: rawPhone } = await params
  const phone = conversationPhone(rawPhone)
  let body: { flow?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const flow = body.flow?.trim() || null

  try {
    // UPSERT: si existe conversación activa la actualiza, sino la crea
    const {agent}=await requireConversation(auth.user,phone,req.nextUrl.searchParams.get('agent'))
    await query(
      `INSERT INTO agent_conversation_state (phone_number,current_flow,agent_key)
       VALUES ($1,$2,$3) ON CONFLICT (agent_key,phone_number)
       DO UPDATE SET current_flow=$2,updated_at=NOW()`,
      [phone, flow, agent]
    )
    emitUpdate(phone, 'status')
    return NextResponse.json({ ok: true })
  } catch (e) {
    if(e instanceof Response) return e
    console.error('[PATCH /api/conversations/[phone]/status]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
