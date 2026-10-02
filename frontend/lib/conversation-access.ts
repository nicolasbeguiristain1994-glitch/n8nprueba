import type { SessionUser } from '@/lib/auth'
import { query } from '@/lib/db'
import { getAccessibleLineIds } from '@/lib/line-visibility'
import { scopedConversationMessages } from '@/lib/conversation-messages'
export const conversationPhone = (phone: string) => phone.replace(/^\+/, '').replace(/\s/g, '')
export async function canReadConversation(user: SessionUser, phone: string) {
  const scope = scopedConversationMessages(user, 2)
  const rows = await query<{allowed: boolean}>(`${scope.sql}
    SELECT EXISTS (SELECT 1 FROM conversation_messages WHERE REPLACE(phone_number,'+','')=$2) AS allowed`,
    [await getAccessibleLineIds(user), conversationPhone(phone), ...scope.params])
  return rows[0]?.allowed ?? false
}
