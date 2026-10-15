export interface MessageReaction { emoji: string; actor: 'self' | 'contact' }

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

// One grapheme, including skin tones, flags, keycaps and ZWJ families. Empty
// means remove the business number's reaction, as required by WhatsApp.
export function isReactionEmoji(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false
  if (value === '') return true
  return [...new Intl.Segmenter('es', { granularity: 'grapheme' }).segment(value)].length === 1
    && /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u.test(value)
}

export function reactionUnavailable(message: { target_wamid?: string | null; line_id?: string | null; status: string; created_at: string | Date; line_type?: string | null; message_type?: string | null }, now = Date.now()): string | null {
  if (!message.target_wamid || !message.line_id) return 'No se pudo identificar la línea original de este mensaje.'
  if (!['received', 'sent', 'delivered', 'read'].includes(message.status)) return 'Este mensaje todavía no está disponible para reaccionar.'
  if (['reaction', 'system', 'unsupported', 'revoked'].includes(message.message_type ?? '')) return 'Este tipo de mensaje no admite reacciones.'
  if (message.line_type === 'cloud' && now - new Date(message.created_at).getTime() >= 30 * 86400_000) return 'WhatsApp permite reaccionar a mensajes de los últimos 30 días.'
  return null
}
