import { agentScope } from './agent-scope'
import type { SessionUser } from '@/lib/auth'
import { query } from '@/lib/db'
import { getAccessibleLineIds } from '@/lib/line-visibility'
import { scopedConversationMessages } from '@/lib/conversation-messages'
export const conversationPhone = (phone: string) => phone.replace(/^\+/, '').replace(/\s/g, '')
export async function canReadConversation(user: SessionUser, phone: string, requested?: string) {
  const scope = scopedConversationMessages(user, 2, requested)
  const rows = await query<{allowed: boolean}>(`${scope.sql}
    SELECT EXISTS (SELECT 1 FROM conversation_messages WHERE REPLACE(phone_number,'+','')=$2) AS allowed`,
    [await conversationLineIds(user), conversationPhone(phone), ...scope.params])
  return rows[0]?.allowed ?? false
}

export function requestedConversationAgent(user: SessionUser, requested: string | null) {
  const agents=agentScope(user)
  const agent=requested || (agents?.length===1 ? agents[0] : 'all')
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(agent)) throw Response.json({error:'Agente inválido'},{status:400})
  if (agents !== null && agent !== 'all' && !agents.includes(agent)) throw Response.json({error:'Sin acceso a este agente'},{status:403})
  return agent
}
export async function requireConversation(user: SessionUser, phone: string, requested: string | null) {
  const agent=requestedConversationAgent(user,requested)
  if (agent==='all') throw Response.json({error:'Seleccioná una bandeja de agente'},{status:400})
  const scope=scopedConversationMessages(user,2,agent)
  const [row]=await query<{line_id:string|null}>(`${scope.sql}
    SELECT line_id FROM conversation_messages WHERE phone_number=$2
    ORDER BY (line_id IS NOT NULL AND (direction='inbound' OR status IN ('sent','delivered','read'))) DESC,created_at DESC,id DESC LIMIT 1`,
    [await conversationLineIds(user),conversationPhone(phone),...scope.params])
  if (!row) throw Response.json({error:'Conversación no encontrada'},{status:404})
  return {agent,lineId:row.line_id}
}

export async function conversationLineIds(user:SessionUser) {
  return agentScope(user)===null ? getAccessibleLineIds(user) : null
}
