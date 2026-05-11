// Facade de compatibilidad: delega al conversation repository.

import { conversationRepository }       from './repositories/conversation.repository'
import type { ConversationWindow }       from './types/domain'

export async function getConversationWindow(
  phoneNumberId: string,
  contactPhone:  string,
): Promise<ConversationWindow> {
  const row = await conversationRepository.findWindow(phoneNumberId, contactPhone)
  if (!row || !row.windowExpiresAt) {
    return { isOpen: false, expiresAt: null, type: null, canSendFree: false, mustUseTemplate: true }
  }

  const now    = new Date()
  const isOpen = row.windowExpiresAt > now
  const type   = row.windowType as 'customer_initiated' | 'business_initiated' | null

  return {
    isOpen,
    expiresAt:       isOpen ? row.windowExpiresAt : null,
    type,
    canSendFree:     isOpen && type === 'customer_initiated',
    mustUseTemplate: !isOpen || type === 'business_initiated',
  }
}

export async function openServiceWindow(
  phoneNumberId: string,
  contactPhone:  string,
  type:          'customer_initiated' | 'business_initiated' = 'customer_initiated',
): Promise<void> {
  return conversationRepository.openWindow(phoneNumberId, contactPhone, type)
}

export async function closeServiceWindow(
  phoneNumberId: string,
  contactPhone:  string,
): Promise<void> {
  const { query } = await import('@/lib/db')
  await query(
    `UPDATE cloud_conversations SET window_expires_at = NOW(), updated_at = NOW()
     WHERE phone_number_id = $1 AND contact_phone = $2`,
    [phoneNumberId, contactPhone],
  )
}

export async function getWindowsExpiringIn(
  phoneNumberId: string,
  withinMinutes = 30,
): Promise<Array<{ contactPhone: string; expiresAt: Date }>> {
  return conversationRepository.getWindowsExpiringIn(phoneNumberId, withinMinutes)
}
