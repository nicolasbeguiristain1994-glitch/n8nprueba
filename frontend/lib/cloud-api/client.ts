// Facade de compatibilidad: delega a los servicios especializados.
// Código existente que importe MetaCloudApiClient seguirá funcionando.
// Para código nuevo, usar los servicios directamente.

import { MessageSenderService }        from './infrastructure/message-sender.service'
import { TemplateService }             from './infrastructure/template.service'
import { PhoneNumberService }          from './infrastructure/phone-number.service'
import { WebhookSubscriptionService }  from './infrastructure/webhook-subscription.service'
import { exchangeCodeForToken, generateLongLivedToken } from './infrastructure/meta-http.gateway'
import type { SendMessageRequest }     from './types/messages'
import type { MetaTemplate, CreateTemplateRequest } from './types/templates'

export class MetaCloudApiClient {
  private readonly messages:   MessageSenderService
  private readonly templates:  TemplateService
  private readonly numbers:    PhoneNumberService
  private readonly webhooks:   WebhookSubscriptionService

  constructor(private readonly accessToken: string) {
    this.messages  = new MessageSenderService(accessToken, 'facade')
    this.templates = new TemplateService(accessToken)
    this.numbers   = new PhoneNumberService(accessToken)
    this.webhooks  = new WebhookSubscriptionService(accessToken)
  }

  async sendMessage(req: SendMessageRequest) {
    const r = await this.messages.send(req)
    return { wamid: r.wamid, status: 'sent' as const }
  }

  async markAsRead(phoneNumberId: string, wamid: string) {
    return this.messages.markAsRead(phoneNumberId, wamid)
  }

  async requestOTP(phoneNumberId: string, method: 'SMS' | 'VOICE' = 'SMS') {
    return this.numbers.requestOTP(phoneNumberId, method)
  }

  async verifyOTP(phoneNumberId: string, code: string) {
    return this.numbers.verifyOTP(phoneNumberId, code)
  }

  async registerNumber(phoneNumberId: string, pin?: string) {
    return this.numbers.register(phoneNumberId, pin)
  }

  async getPhoneNumberInfo(phoneNumberId: string) {
    return this.numbers.getInfo(phoneNumberId)
  }

  async listPhoneNumbers(wabaId: string) {
    return this.numbers.list(wabaId)
  }

  async createTemplate(req: CreateTemplateRequest): Promise<{ id: string; status: string }> {
    return this.templates.create(req)
  }

  async listTemplates(wabaId: string, limit?: number): Promise<MetaTemplate[]> {
    return this.templates.list(wabaId, limit)
  }

  async getTemplate(templateId: string): Promise<MetaTemplate> {
    return this.templates.get(templateId)
  }

  async deleteTemplate(wabaId: string, templateName: string) {
    return this.templates.delete(wabaId, templateName)
  }

  async subscribeToWebhooks(wabaId: string) {
    return this.webhooks.subscribeAll(wabaId)
  }

  async subscribeNumberFields(wabaId: string, fields: string[]) {
    return this.webhooks.subscribeFields(wabaId, fields)
  }

  static async exchangeCodeForToken(code: string, appId: string, appSecret: string) {
    return exchangeCodeForToken(code, appId, appSecret)
  }

  static async generateSystemUserToken(appId: string, appSecret: string, shortLivedToken: string) {
    return generateLongLivedToken(appId, appSecret, shortLivedToken)
  }
}
