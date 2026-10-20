import { query } from '@/lib/db'
import { CampaignRiskError, assertCloudSendRiskClear, recordCampaignProviderRisk, CAMPAIGN_RISK_CLEAR_SQL } from '@/lib/campaign-risk'
import { CloudApiError, OptOutError } from '../errors'
// Responsabilidad única: enviar mensajes via Graph API y construir sus payloads.

import { withGlobalSendGuard } from '@/lib/global-opt-out'
import { isReactionEmoji } from '@/lib/message-reactions'
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
    const riskContext = { campaignId: req.campaignId, phoneNumberId: req.phoneNumberId,
      templateName: req.template?.name }
    let providerStarted = false
    try {
      const data = await withGlobalSendGuard(req.to, async db => {
        try {
          // Hold the campaign row until the provider call finishes. A committed
          // pause then fences later sends, including other workers and lines.
          if (req.campaignId) {
            const { rows } = await db.query(`SELECT c.id FROM campaigns c WHERE c.id=$1
              AND c.status='running' AND ${CAMPAIGN_RISK_CLEAR_SQL} FOR SHARE OF c`, [req.campaignId])
            if (!rows.length) throw new CampaignRiskError('La campaña está detenida o tiene una alerta de riesgo pendiente.')
          }
          await assertCloudSendRiskClear(riskContext, db)
        } catch (error) {
          if (error instanceof CampaignRiskError) throw error
          throw new CampaignRiskError('No se pudo verificar la seguridad del envío; no se envió el mensaje.')
        }
        providerStarted = true
        return this.gw.post<{ messages: Array<{ id: string }> }>(`/${req.phoneNumberId}/messages`, payload)
      }, {provider:"cloud",sourceId:req.phoneNumberId,campaignId:req.campaignId,agentCode:req.agentCode})
      return { wamid: data.messages[0].id }
    } catch (error) {
      if (!providerStarted && !(error instanceof CampaignRiskError) && !(error instanceof OptOutError)) {
        throw new CampaignRiskError('No se pudo verificar la seguridad del envío; no se envió el mensaje.')
      }
      // Persist after releasing the send transaction: pausing the campaign must
      // not wait on a row lock held by this same request. Preserve a definite
      // Meta rejection even if recording its risk signal fails.
      if (error instanceof CloudApiError && error.code) {
        try {
          await recordCampaignProviderRisk({ ...riskContext, errorCode: error.code, errorMessage: error.message })
        } catch {
          console.error('[campaign-risk] No se pudo persistir la señal del proveedor')
          if (req.campaignId) await query(`UPDATE campaigns SET status='paused', pause_reason='risk_detected', updated_at=NOW()
            WHERE id=$1 AND status='running'`, [req.campaignId]).catch(() => {})
        }
      }
      throw error
    }
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
  if (req.type === 'reaction' && (!req.reaction?.messageId?.trim() || !isReactionEmoji(req.reaction.emoji))) throw new Error('Reacción inválida')
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
