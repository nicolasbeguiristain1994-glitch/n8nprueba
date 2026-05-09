// ─── Meta Graph API Version ──────────────────────────────────────────────────
export const META_API_VERSION = 'v21.0'
export const META_BASE_URL    = `https://graph.facebook.com/${META_API_VERSION}`

// ─── Número registrado en Cloud API ──────────────────────────────────────────
export interface CloudNumber {
  id:                 string
  wabaId:             string
  phoneNumberId:      string
  displayPhone:       string
  verifiedName:       string | null
  accessToken:        string
  tokenExpiresAt:     Date | null
  status:             CloudNumberStatus
  coexistenceEnabled: boolean
  contactsSynced:     boolean
  historySynced:      boolean
  historySyncDays:    number
  qualityRating:      QualityRating
  messagingLimitTier: MessagingLimitTier
  whatsappLineId:     string | null
  onboardedAt:        Date | null
  createdAt:          Date
  updatedAt:          Date
}

export type CloudNumberStatus =
  | 'pending'
  | 'code_sent'
  | 'verified'
  | 'active'
  | 'suspended'
  | 'banned'

export type QualityRating = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN'
export type MessagingLimitTier = 'TIER_1K' | 'TIER_10K' | 'TIER_100K' | 'UNLIMITED'

// ─── Embedded Signup / Coexistence ───────────────────────────────────────────
export interface EmbeddedSignupResult {
  code:          string   // Auth code para intercambiar por token
  wabaId:        string
  phoneNumberId: string
}

export interface OnboardingRequest {
  code:          string
  wabaId:        string
  phoneNumberId: string
  whatsappLineId?: string
}

export interface OTPVerificationRequest {
  phoneNumberId: string
  otpCode:       string
}

// ─── SMB App Data Sync ────────────────────────────────────────────────────────
export type SmbSyncType = 'smb_app_state_sync' | 'history'

export interface SmbSyncRequest {
  wabaId:        string
  phoneNumberId: string
  syncType:      SmbSyncType
  historyDays?:  number  // solo para syncType = 'history', máx 180
}

export interface SmbSyncStatus {
  syncType:   SmbSyncType
  status:     'pending' | 'in_progress' | 'completed' | 'failed'
  progress?:  number   // 0-100
  error?:     string
}

// ─── Mensajes ─────────────────────────────────────────────────────────────────
export type MessageType =
  | 'text'
  | 'template'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'reaction'
  | 'location'
  | 'contacts'
  | 'interactive'

export type MessageDirection = 'outbound' | 'inbound' | 'echo'
export type MessageStatus    = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'deleted'

export interface SendMessageRequest {
  phoneNumberId:   string
  to:              string        // E.164
  type:            MessageType
  text?:           TextContent
  template?:       TemplateContent
  image?:          MediaContent
  video?:          MediaContent
  audio?:          MediaContent
  document?:       DocumentContent
  sticker?:        MediaContent
  reaction?:       ReactionContent
  location?:       LocationContent
  interactive?:    InteractiveContent
  contextMessageId?: string     // para replies (context.message_id)
  campaignId?:     string
  sentByUserId?:   string
}

export interface TextContent {
  body:       string
  previewUrl?: boolean
}

export interface TemplateContent {
  name:       string
  language:   { code: string }
  components: TemplateComponent[]
}

export type TemplateComponent =
  | { type: 'header';  parameters: TemplateParameter[] }
  | { type: 'body';    parameters: TemplateParameter[] }
  | { type: 'button';  sub_type: string; index: string; parameters: TemplateParameter[] }

export type TemplateParameter =
  | { type: 'text';     text: string }
  | { type: 'currency'; currency: { fallback_value: string; code: string; amount_1000: number } }
  | { type: 'date_time'; date_time: { fallback_value: string } }
  | { type: 'image';    image: { link?: string; id?: string } }
  | { type: 'document'; document: { link?: string; id?: string; filename?: string } }
  | { type: 'video';    video: { link?: string; id?: string } }
  | { type: 'payload';  payload: string }  // para botones

export interface MediaContent {
  id?:       string   // Media ID subido a Meta
  link?:     string   // URL pública
  caption?:  string
}

export interface DocumentContent extends MediaContent {
  filename?: string
}

export interface ReactionContent {
  messageId: string  // WAMID del mensaje al que reaccionar
  emoji:     string
}

export interface LocationContent {
  latitude:  number
  longitude: number
  name?:     string
  address?:  string
}

export interface InteractiveContent {
  type:   'button' | 'list' | 'product' | 'product_list' | 'cta_url' | 'flow'
  header?: { type: 'text' | 'image' | 'video' | 'document'; text?: string; image?: MediaContent }
  body:   { text: string }
  footer?: { text: string }
  action: Record<string, unknown>
}

export interface SendMessageResult {
  messageId:  string   // UUID interno
  wamid:      string   // wa.me message ID de Meta
  status:     MessageStatus
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────
export interface WebhookPayload {
  object:  'whatsapp_business_account'
  entry:   WebhookEntry[]
}

export interface WebhookEntry {
  id:       string  // WABA ID
  changes:  WebhookChange[]
}

export interface WebhookChange {
  value: WebhookValue
  field: 'messages' | 'message_template_status_update' | 'history' | 'smb_app_state_sync' | 'smb_message_echoes'
}

export interface WebhookValue {
  messaging_product:  'whatsapp'
  metadata:           { display_phone_number: string; phone_number_id: string }
  contacts?:          WebhookContact[]
  messages?:          WebhookMessage[]
  statuses?:          WebhookStatus[]
  errors?:            MetaError[]
}

export interface WebhookContact {
  profile:  { name: string }
  wa_id:    string
}

export interface WebhookMessage {
  from:       string
  id:         string   // WAMID
  timestamp:  string
  type:       MessageType
  text?:      { body: string }
  image?:     { caption?: string; mime_type: string; sha256: string; id: string }
  video?:     { caption?: string; mime_type: string; sha256: string; id: string }
  audio?:     { mime_type: string; sha256: string; id: string; voice?: boolean }
  document?:  { caption?: string; filename: string; mime_type: string; sha256: string; id: string }
  sticker?:   { mime_type: string; sha256: string; id: string; animated: boolean }
  reaction?:  { message_id: string; emoji: string }
  location?:  { latitude: number; longitude: number; name?: string; address?: string }
  interactive?: { type: string; button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string; description?: string } }
  context?:   { from: string; id: string }
  referral?:  { source_url: string; source_id: string; source_type: string; headline: string; body: string; media_type: string }
}

export interface WebhookStatus {
  id:           string   // WAMID
  status:       'sent' | 'delivered' | 'read' | 'failed' | 'deleted'
  timestamp:    string
  recipient_id: string
  conversation?: {
    id:     string
    origin: { type: string }
  }
  pricing?: {
    billable:       boolean
    pricing_model:  string
    category:       string
  }
  errors?: MetaError[]
}

// ─── Errores de Meta ──────────────────────────────────────────────────────────
export interface MetaError {
  code:       number
  title:      string
  message?:   string
  error_data?: { details?: string; messaging_product?: string }
  href?:      string
}

export interface MetaApiError {
  error: {
    message:    string
    type:       string
    code:       number
    error_subcode?: number
    fbtrace_id?: string
    error_data?: Record<string, unknown>
  }
}

// ─── Templates ────────────────────────────────────────────────────────────────
export type TemplateStatus = 'APPROVED' | 'PENDING' | 'REJECTED' | 'DISABLED' | 'IN_APPEAL' | 'PAUSED'
export type TemplateCategory = 'UTILITY' | 'MARKETING' | 'AUTHENTICATION'

export interface CreateTemplateRequest {
  name:       string
  category:   TemplateCategory
  language:   string
  components: unknown[]
  wabaId:     string
}

export interface MetaTemplate {
  id:               string
  name:             string
  status:           TemplateStatus
  category:         TemplateCategory
  language:         string
  components:       unknown[]
  rejected_reason?: string
  quality_score?:   { score: string; date: number; reasons?: string[] }
}

// ─── Queue ────────────────────────────────────────────────────────────────────
export interface QueuedMessage {
  jobId:         string
  messageId:     string
  phoneNumberId: string
  to:            string
  payload:       Record<string, unknown>  // Graph API message payload
  attempts:      number
  campaignId?:   string
}

export interface QueueConfig {
  maxRetries:    number   // default 3
  backoffBase:   number   // ms, default 2000
  backoffMax:    number   // ms, default 60000
  rateLimitMs:   number   // ms entre mensajes por número, default 50 (= 20 msg/s)
}

// ─── Rate Limiter ─────────────────────────────────────────────────────────────
export interface RateLimitResult {
  allowed:      boolean
  retryAfterMs: number
  remaining:    number
}

// ─── Conversation Window ──────────────────────────────────────────────────────
export interface ConversationWindow {
  isOpen:        boolean
  expiresAt:     Date | null
  type:          'customer_initiated' | 'business_initiated' | null
  canSendFree:   boolean   // true si hay ventana de servicio abierta (customer_initiated)
  mustUseTemplate: boolean  // true si no hay ventana o es business_initiated
}
