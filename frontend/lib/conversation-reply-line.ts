import { query } from '@/lib/db'
import type { EligibleLine } from '@/lib/campaign-distributor'

// A customer service window belongs to a recipient AND a business number.
// Use the latest inbound message visible to this operator, including button
// replies. Never rotate to another sender if the originating line is unavailable.
export async function findConversationReplyLine(
  phone: string,
  accessibleLineIds: string[] | null,
  eligibleLines: EligibleLine[],
): Promise<EligibleLine | null> {
  const [origin] = await query<{ line_id: string; phone_number_id: string; display_name: string }>(
    `SELECT cn.whatsapp_line_id AS line_id, cm.phone_number_id,
       COALESCE(wl.display_name, wl.line_key) AS display_name
     FROM cloud_messages cm
     JOIN cloud_conversations cc ON cc.id=cm.conversation_id AND cc.phone_number_id=cm.phone_number_id
     JOIN cloud_numbers cn ON cn.phone_number_id=cm.phone_number_id
     JOIN whatsapp_lines wl ON wl.id=cn.whatsapp_line_id
     WHERE regexp_replace(cc.contact_phone,'[^0-9]','','g')=$1
       AND cm.direction='inbound'
       AND ($2::uuid[] IS NULL OR cn.whatsapp_line_id=ANY($2::uuid[]))
     ORDER BY COALESCE(cm.sent_at,cm.created_at) DESC,cm.created_at DESC,cm.id DESC LIMIT 1`,
    [phone.replace(/\D/g, ''), accessibleLineIds],
  )
  if (!origin) return null
  const line = eligibleLines.find(item => item.id === origin.line_id && item.phone_number_id === origin.phone_number_id)
  if (!line) throw new Error(`La conversación corresponde a "${origin.display_name}", pero esa línea no está disponible para responder. Revisá su estado y sus límites.`)
  return line
}
