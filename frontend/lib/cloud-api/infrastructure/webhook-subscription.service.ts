// Responsabilidad única: suscripción a campos de webhook del WABA.

import { MetaHttpGateway } from './meta-http.gateway'

// Campos obligatorios para Coexistence según documentación de Meta (mayo 2026)
export const COEXISTENCE_WEBHOOK_FIELDS = [
  'messages',                        // mensajes entrantes y estados de entrega
  'history',                         // sync de historial completado
  'smb_app_state_sync',              // sync de contactos de WA Business App
  'smb_message_echoes',              // mensajes enviados desde WA Business App
  'message_template_status_update',  // aprobación/rechazo de plantillas
  'phone_number_quality_update',     // alertas de calidad del número
] as const

export type CoexistenceWebhookField = (typeof COEXISTENCE_WEBHOOK_FIELDS)[number]

export class WebhookSubscriptionService {
  private readonly gw: MetaHttpGateway

  constructor(accessToken: string) {
    this.gw = new MetaHttpGateway(accessToken, { timeoutMs: 10_000 })
  }

  async subscribeAll(wabaId: string): Promise<void> {
    await this.subscribeFields(wabaId, [...COEXISTENCE_WEBHOOK_FIELDS])
  }

  async subscribeFields(wabaId: string, fields: string[]): Promise<void> {
    await this.gw.post(`/${wabaId}/subscribed_apps`, { subscribed_fields: fields })
  }

  async listSubscriptions(wabaId: string): Promise<{ subscribed_fields: string[] }[]> {
    const data = await this.gw.get<{ data: { subscribed_fields: string[] }[] }>(
      `/${wabaId}/subscribed_apps`,
    )
    return data.data
  }
}
