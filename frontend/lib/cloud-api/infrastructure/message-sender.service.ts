// Responsabilidad única: enviar mensajes via Graph API y construir sus payloads.

import { MetaHttpGateway } from './meta-http.gateway'
import type { SendMessageRequest } from '../types/messages'

export interface SendResult {
  wamid: string
}

export class MessageSenderService {
  private readonly gw: MetaHttpGateway

  constructor(accessToken: string, phoneNumberId: string) {
    this.gw = new MetaHttpGateway(accessToken, {
      circuitBreakerKey: `meta:send:${phoneNumberId}`,
      timeoutMs:         12_000,
    })
  }

  async send(req: SendMessageRequest): Promise<SendResult> {
    const payload = buildMessagePayload(req)
    const data    = await this.gw.post<{ messages: Array<{ id: string }> }>(
      `/${req.phoneNumberId}/messages`,
      payload,
    )
    return { wamid: data.messages[0].id }
  }

  async markAsRead(phoneNumberId: string, wamid: string): Promise<void> {
    await this.gw.post(`/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status:            'read',
      message_id:        wamid,
    }).catch(() => {}) // best-effort: no bloquear flujo principal
  }
}

// ─── Construcción de payload (función pura, testeable de forma aislada) ───────

export function buildMessagePayload(req: SendMessageRequest): Record<string, unknown> {
  const supported = ['text','template','image','video','audio','document','sticker','reaction','location','interactive']
  if (!supported.includes(req.type) || !req[req.type as keyof SendMessageRequest]) throw new Error('Tipo o contenido de mensaje inválido')
  if (req.type === 'text' && (!req.text?.body?.trim() || req.text.body.length > 4096)) throw new Error('El texto debe tener entre 1 y 4096 caracteres')
  if (req.type === 'template' && (!req.template?.name || !req.template.language?.code)) throw new Error('Falta nombre o idioma de la plantilla')
  const base: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to:                req.to,
    type:              req.type,
  }

  if (req.contextMessageId) {
    base.context = { message_id: req.contextMessageId }
  }

  const contentMap: Partial<Record<SendMessageRequest['type'], unknown>> = {
    text:        req.text    ? { body: req.text.body, preview_url: req.text.previewUrl ?? false } : undefined,
    template:    req.template,
    image:       req.image,
    video:       req.video,
    audio:       req.audio,
    document:    req.document,
    sticker:     req.sticker,
    location:    req.location,
    interactive: req.interactive,
    reaction:    req.reaction
      ? { message_id: req.reaction.messageId, emoji: req.reaction.emoji }
      : undefined,
  }

  const content = contentMap[req.type]
  if (content !== undefined) {
    base[req.type] = content
  }

  return base
}
