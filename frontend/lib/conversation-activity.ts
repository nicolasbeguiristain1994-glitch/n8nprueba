import type { Conv } from './scoring/conversation-scoring'

export type ConversationActivity = Pick<Conv,
  'last_message' | 'last_direction' | 'last_status' | 'last_at' |
  'last_message_id' | 'last_message_key' | 'is_unread'>

export function activityTime(value: string): number {
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : 0
}

// Match the server order, including a stable tie-breaker independent of priority.
export function compareConversationActivity(a: Conv, b: Conv): number {
  return activityTime(b.last_at) - activityTime(a.last_at)
    || (a.phone_number < b.phone_number ? -1 : a.phone_number > b.phone_number ? 1 : 0)
}

export function conversationActivity(conv: ConversationActivity): ConversationActivity {
  return {
    last_message: conv.last_message, last_direction: conv.last_direction,
    last_status: conv.last_status, last_at: conv.last_at,
    last_message_id: conv.last_message_id, last_message_key: conv.last_message_key,
    is_unread: conv.is_unread,
  }
}
