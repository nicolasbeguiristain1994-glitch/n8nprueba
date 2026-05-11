// Tipos del dominio: entidades y value objects de la plataforma

export const META_API_VERSION = 'v21.0'
export const META_BASE_URL    = `https://graph.facebook.com/${META_API_VERSION}`

export type CloudNumberStatus  = 'pending' | 'code_sent' | 'verified' | 'active' | 'suspended' | 'banned'
export type QualityRating      = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN'
export type MessagingLimitTier = 'TIER_1K' | 'TIER_10K' | 'TIER_100K' | 'UNLIMITED'
export type SmbSyncType        = 'smb_app_state_sync' | 'history'
export type MessageDirection   = 'outbound' | 'inbound' | 'echo'
export type MessageStatus      = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'deleted'

export interface CloudNumber {
  id:                 string
  wabaId:             string
  phoneNumberId:      string
  displayPhone:       string
  verifiedName:       string | null
  // accessToken NO se expone en el dominio — siempre via TokenStore
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

export interface ConversationWindow {
  isOpen:          boolean
  expiresAt:       Date | null
  type:            'customer_initiated' | 'business_initiated' | null
  canSendFree:     boolean
  mustUseTemplate: boolean
}

export interface SmbSyncStatus {
  syncType:  SmbSyncType
  status:    'pending' | 'in_progress' | 'completed' | 'failed'
  progress?: number
  error?:    string
}

export interface SmbSyncRequest {
  wabaId:        string
  phoneNumberId: string
  syncType:      SmbSyncType
  historyDays?:  number
}

export interface OnboardingRequest {
  code:            string
  wabaId:          string
  phoneNumberId:   string
  whatsappLineId?: string
}

export interface OTPVerificationRequest {
  phoneNumberId: string
  otpCode:       string
}

export interface EmbeddedSignupResult {
  code:          string
  wabaId:        string
  phoneNumberId: string
}

export interface RateLimitResult {
  allowed:      boolean
  retryAfterMs: number
  remaining:    number
}

export interface QueueConfig {
  maxRetries:  number
  backoffBase: number
  backoffMax:  number
  rateLimitMs: number
}
