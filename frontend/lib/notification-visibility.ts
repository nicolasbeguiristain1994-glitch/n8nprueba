import type { SessionUser } from '@/lib/auth'
import { canAccess } from '@/lib/permissions'
import { getAccessibleLineIds } from '@/lib/line-visibility'
import { scopedConversationMessages } from '@/lib/conversation-messages'
import { contactScope } from '@/lib/contact-visibility'

/** SQL used both when creating a notification and on every subsequent read.
 * Resource access can change after delivery; title/body must then disappear too.
 */
export async function notificationScope(user: SessionUser) {
  const messages = scopedConversationMessages(user, 2)
  const params: unknown[] = [await getAccessibleLineIds(user), user.user_id, ...messages.params]
  const contacts = contactScope(user, params.length, 'notification_contact')
  params.push(...contacts.params)
  const yes = (resource: Parameters<typeof canAccess>[1]) => canAccess(user, resource, 'read') ? 'TRUE' : 'FALSE'
  const admin = user.role === 'admin' ? 'TRUE' : 'FALSE'
  return {
    cte: messages.sql,
    params,
    sql: `(CASE notifications.related_type
      WHEN 'conversation' THEN ${yes('conversations')} AND EXISTS (
        SELECT 1 FROM conversation_messages m WHERE REPLACE(m.phone_number,'+','')=REPLACE(notifications.related_id,'+',''))
      WHEN 'contact' THEN ${yes('contacts')} AND EXISTS (
        SELECT 1 FROM contacts notification_contact WHERE notification_contact.id::text=notifications.related_id AND ${contacts.sql})
      WHEN 'campaign' THEN ${yes('campaigns')} AND EXISTS (
        SELECT 1 FROM campaigns cp WHERE cp.id::text=notifications.related_id AND (${admin} OR cp.owned_by=$2::uuid))
      WHEN 'line' THEN ${yes('lines')} AND ($1::uuid[] IS NULL OR notifications.related_id=ANY($1::text[]))
      WHEN 'task' THEN ${yes('tasks')} AND EXISTS (
        SELECT 1 FROM tasks t WHERE t.id::text=notifications.related_id AND t.deleted_at IS NULL
        AND (${admin} OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id=t.id AND ta.user_id=$2::uuid)))
      ELSE notifications.related_type IS NULL
    END)`,
  }
}
