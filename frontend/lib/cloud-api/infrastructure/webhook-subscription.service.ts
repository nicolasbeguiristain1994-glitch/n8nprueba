// Link a WABA to the app. Individual fields must also be enabled in the app's
// WhatsApp webhook subscription; /WABA/subscribed_apps does not accept fields.

import { MetaHttpGateway } from './meta-http.gateway'

// Required app-level fields; including these here does not enable them in Meta.
export const COEXISTENCE_WEBHOOK_FIELDS = [
  'messages',                        // mensajes entrantes y estados de entrega
  'history',                         // sync de historial completado
  'smb_app_state_sync',              // sync de contactos de WA Business App
  'smb_message_echoes',              // mensajes enviados desde WA Business App
  'message_template_status_update',  // aprobación/rechazo de plantillas
  'message_template_quality_update', // calidad de plantillas
  'account_update',                  // infracciones/restricciones de la WABA
  'phone_number_quality_update',     // throughput; la calidad se consulta por API
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
    if (!fields.length) throw new Error('Indicá los campos esperados de webhook')
    await this.gw.post(`/${wabaId}/subscribed_apps`, {})
  }

  async listSubscriptions(wabaId: string): Promise<Array<{ whatsapp_business_api_data: { id: string; name: string; link?: string }; override_callback_uri?: string }>> {
    const data = await this.gw.get<{ data: Array<{ whatsapp_business_api_data: { id: string; name: string; link?: string }; override_callback_uri?: string }> }>(
      `/${wabaId}/subscribed_apps`,
    )
    return data.data
  }
}
