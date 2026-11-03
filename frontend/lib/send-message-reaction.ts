import { query } from './db'
import { withGlobalSendGuard } from './global-opt-out'
import { evolutionReplyEligibleExpr } from './line-eligibility'
import { sendViaCloud, CloudSendOutcomeUnknownError } from './campaign-distributor'
import { CloudApiError, OptOutError } from './cloud-api/errors'

export interface ReactionTarget {
  id: string; phone_number: string; status: string; created_at: string;
  direction: string; target_wamid: string; line_id: string;
  line_type: string; phone_number_id: string | null; message_type: string;
}

export async function sendMessageReaction(target: ReactionTarget, emoji: string) {
  if (target.line_type === 'cloud') {
    return sendViaCloud({ id: target.line_id, phone_number_id: target.phone_number_id }, target.phone_number,
      { kind: 'reaction', messageId: target.target_wamid, emoji }, undefined,
      { purpose: 'conversation_reply', reserveCapacity: true })
  }
  const key = process.env.EVOLUTION_GLOBAL_API_KEY || process.env.EVOLUTION_API_KEY
  if (!key) throw new CloudApiError('La línea de WhatsApp no está configurada.')
  await query('SELECT reset_line_counters_if_due()')
  const [line] = await query<{ evolution_url: string | null; evolution_instance: string }>(`
    SELECT evolution_url,evolution_instance FROM whatsapp_lines wl
    WHERE wl.id=$1 AND ${evolutionReplyEligibleExpr('wl')}`, [target.line_id])
  if (!line) throw new CloudApiError('La línea original no está disponible para reaccionar.')
  const origin = line.evolution_url || process.env.EVOLUTION_URL
  if (!origin || !line.evolution_instance) throw new CloudApiError('La línea de WhatsApp no está configurada.')
  try {
    const response = await withGlobalSendGuard(target.phone_number, () => fetch(
      `${origin}/message/sendReaction/${encodeURIComponent(line.evolution_instance)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: key },
        body: JSON.stringify({ key: {
          remoteJid: `${target.phone_number.replace(/\D/g, '')}@s.whatsapp.net`,
          fromMe: target.direction === 'outbound', id: target.target_wamid,
        }, reaction: emoji }), signal: AbortSignal.timeout(20_000),
      }),{provider:'evolution',sourceId:line.evolution_instance,contextWamid:target.direction==='outbound'?target.target_wamid:undefined})
    if (!response.ok) {
      if (response.status >= 500) throw new CloudSendOutcomeUnknownError()
      throw new CloudApiError('WhatsApp rechazó la reacción. Revisá la conexión de la línea.', response.status)
    }
    const data = await response.json()
    const messageId = data?.key?.id || data?.id
    if (typeof messageId !== 'string' || !messageId) throw new CloudSendOutcomeUnknownError()
    return { messageId }
  } catch (error) {
    if (error instanceof CloudApiError || error instanceof OptOutError) throw error
    throw new CloudSendOutcomeUnknownError()
  }
}
