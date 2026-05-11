// Tipos de los payloads de Webhook de Meta

import type { MessageType } from './domain'

export interface WebhookPayload {
  object: 'whatsapp_business_account'
  entry:  WebhookEntry[]
}

export interface WebhookEntry {
  id:      string
  changes: WebhookChange[]
}

export type WebhookField =
  | 'messages'
  | 'message_template_status_update'
  | 'history'
  | 'smb_app_state_sync'
  | 'smb_message_echoes'
  | 'phone_number_quality_update'

export interface WebhookChange {
  value: WebhookValue
  field: WebhookField
}

export interface WebhookValue {
  messaging_product: 'whatsapp'
  metadata:          WebhookMetadata
  contacts?:         WebhookContact[]
  messages?:         WebhookMessage[]
  statuses?:         WebhookStatus[]
  errors?:           MetaWebhookError[]
}

export interface WebhookMetadata {
  display_phone_number: string
  phone_number_id:      string
}

export interface WebhookContact {
  profile: { name: string }
  wa_id:   string
}

export interface WebhookMessage {
  from:         string
  id:           string
  timestamp:    string
  type:         MessageType
  text?:        { body: string }
  image?:       { caption?: string; mime_type: string; sha256: string; id: string }
  video?:       { caption?: string; mime_type: string; sha256: string; id: string }
  audio?:       { mime_type: string; sha256: string; id: string; voice?: boolean }
  document?:    { caption?: string; filename: string; mime_type: string; sha256: string; id: string }
  sticker?:     { mime_type: string; sha256: string; id: string; animated: boolean }
  reaction?:    { message_id: string; emoji: string }
  location?:    { latitude: number; longitude: number; name?: string; address?: string }
  interactive?: {
    type:          string
    button_reply?: { id: string; title: string }
    list_reply?:   { id: string; title: string; description?: string }
  }
  context?:     { from: string; id: string }
  referral?:    { source_url: string; source_id: string; source_type: string; headline: string; body: string; media_type: string }
}

export interface WebhookStatus {
  id:            string
  status:        'sent' | 'delivered' | 'read' | 'failed' | 'deleted'
  timestamp:     string
  recipient_id:  string
  conversation?: { id: string; origin: { type: string } }
  pricing?:      { billable: boolean; pricing_model: string; category: string }
  errors?:       MetaWebhookError[]
}

export interface WebhookTemplateStatusUpdate {
  message_template_id:       string
  message_template_name:     string
  message_template_language: string
  event:                     'APPROVED' | 'REJECTED' | 'DISABLED' | 'PAUSED'
  reason?:                   string
}

export interface WebhookSyncEvent {
  event?:  string
  error?:  string
}

// Error tal como viene en el payload del webhook (diferente de MetaApiError de REST)
export interface MetaWebhookError {
  code:        number
  title:       string
  message?:    string
  error_data?: { details?: string }
}
