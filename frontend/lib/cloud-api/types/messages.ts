// Tipos relacionados con el envío y contenido de mensajes

import type { MessageType, MessageStatus, MessageDirection } from './domain'
export type { MessageType, MessageStatus, MessageDirection }

export interface SendMessageRequest {
  phoneNumberId:    string
  to:               string
  type:             MessageType
  text?:            TextContent
  template?:        TemplateContent
  image?:           MediaContent
  video?:           MediaContent
  audio?:           MediaContent
  document?:        DocumentContent
  sticker?:         MediaContent
  reaction?:        ReactionContent
  location?:        LocationContent
  interactive?:     InteractiveContent
  contextMessageId?: string
  campaignId?:      string
  sentByUserId?:    string
}

export interface SendMessageResult {
  messageId: string
  wamid:     string
  status:    MessageStatus
}

export interface TextContent {
  body:        string
  previewUrl?: boolean
}

export interface TemplateContent {
  name:       string
  language:   { code: string }
  components: TemplateComponent[]
}

export type TemplateComponent =
  | { type: 'header'; parameters: TemplateParameter[] }
  | { type: 'body';   parameters: TemplateParameter[] }
  | { type: 'button'; sub_type: string; index: string; parameters: TemplateParameter[] }

export type TemplateParameter =
  | { type: 'text';      text: string }
  | { type: 'currency';  currency: { fallback_value: string; code: string; amount_1000: number } }
  | { type: 'date_time'; date_time: { fallback_value: string } }
  | { type: 'image';     image: { link?: string; id?: string } }
  | { type: 'document';  document: { link?: string; id?: string; filename?: string } }
  | { type: 'video';     video: { link?: string; id?: string } }
  | { type: 'payload';   payload: string }

export interface MediaContent {
  id?:      string
  link?:    string
  caption?: string
}

export interface DocumentContent extends MediaContent {
  filename?: string
}

export interface ReactionContent {
  messageId: string
  emoji:     string
}

export interface LocationContent {
  latitude:  number
  longitude: number
  name?:     string
  address?:  string
}

export interface InteractiveContent {
  type:    'button' | 'list' | 'product' | 'product_list' | 'cta_url' | 'flow'
  header?: { type: 'text' | 'image' | 'video' | 'document'; text?: string; image?: MediaContent }
  body:    { text: string }
  footer?: { text: string }
  action:  Record<string, unknown>
}

export interface QueuedMessage {
  jobId:         string
  messageId:     string
  phoneNumberId: string
  to:            string
  payload:       Record<string, unknown>
  attempts:      number
  campaignId?:   string
}
