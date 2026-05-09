import {
  META_BASE_URL,
  type SendMessageRequest,
  type MetaTemplate,
  type CreateTemplateRequest,
  type MetaApiError,
} from './types'
import {
  CloudApiError,
  TokenExpiredError,
  fromHttpResponse,
  classifyMetaError,
} from './errors'

// ─── Opciones de fetch con timeout y retry automático en 5xx ─────────────────

interface FetchOptions extends RequestInit {
  timeoutMs?: number
}

async function fetchWithTimeout(url: string, opts: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = 15_000, ...fetchOpts } = opts
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...fetchOpts, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// ─── Cliente principal ────────────────────────────────────────────────────────

export class MetaCloudApiClient {
  private readonly baseUrl = META_BASE_URL

  constructor(private readonly accessToken: string) {}

  // ── Envío de mensajes ─────────────────────────────────────────────────────

  async sendMessage(req: SendMessageRequest): Promise<{ wamid: string; status: string }> {
    const payload = this.buildMessagePayload(req)
    const res = await this.post(`/${req.phoneNumberId}/messages`, payload)
    const data = await this.parseResponse<{ messages: Array<{ id: string }>; contacts: Array<{ wa_id: string }> }>(res)
    return { wamid: data.messages[0].id, status: 'sent' }
  }

  // ── Registro y verificación de número (Coexistence) ───────────────────────

  async requestOTP(phoneNumberId: string, method: 'SMS' | 'VOICE' = 'SMS'): Promise<void> {
    const res = await this.post(`/${phoneNumberId}/request_code`, {
      code_method:         method,
      language:            'es',
    })
    await this.parseResponse(res)
  }

  async verifyOTP(phoneNumberId: string, code: string): Promise<void> {
    const res = await this.post(`/${phoneNumberId}/verify_code`, { code })
    await this.parseResponse(res)
  }

  async registerNumber(phoneNumberId: string, pin: string = '000000'): Promise<void> {
    const res = await this.post(`/${phoneNumberId}/register`, {
      messaging_product: 'whatsapp',
      pin,
    })
    await this.parseResponse(res)
  }

  // ── Intercambio de código OAuth por token ─────────────────────────────────

  static async exchangeCodeForToken(
    code:          string,
    appId:         string,
    appSecret:     string,
  ): Promise<{ accessToken: string; tokenType: string }> {
    const url = new URL('https://graph.facebook.com/oauth/access_token')
    url.searchParams.set('client_id',     appId)
    url.searchParams.set('client_secret', appSecret)
    url.searchParams.set('code',          code)

    const res = await fetchWithTimeout(url.toString())
    const body = await res.json() as { access_token?: string; token_type?: string } & MetaApiError

    if (!res.ok || !body.access_token) {
      const code_ = (body as MetaApiError).error?.code ?? 0
      throw new CloudApiError(
        (body as MetaApiError).error?.message ?? 'Error al intercambiar código OAuth',
        code_,
      )
    }

    return { accessToken: body.access_token, tokenType: body.token_type ?? 'bearer' }
  }

  // Genera un System User Access Token de larga duración
  static async generateSystemUserToken(
    appId:         string,
    appSecret:     string,
    shortLivedToken: string,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const url = new URL(`https://graph.facebook.com/${META_BASE_URL.split('/').pop()}/oauth/access_token`)
    url.searchParams.set('grant_type',    'fb_exchange_token')
    url.searchParams.set('client_id',     appId)
    url.searchParams.set('client_secret', appSecret)
    url.searchParams.set('fb_exchange_token', shortLivedToken)

    const res = await fetchWithTimeout(url.toString())
    const body = await res.json() as { access_token?: string; expires_in?: number } & MetaApiError

    if (!res.ok || !body.access_token) {
      throw new CloudApiError((body as MetaApiError).error?.message ?? 'Error al generar token long-lived')
    }

    return { accessToken: body.access_token, expiresIn: body.expires_in ?? 0 }
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  async createTemplate(req: CreateTemplateRequest): Promise<{ id: string; status: string }> {
    const res = await this.post(`/${req.wabaId}/message_templates`, {
      name:       req.name,
      category:   req.category,
      language:   req.language,
      components: req.components,
    })
    const data = await this.parseResponse<{ id: string; status: string }>(res)
    return data
  }

  async listTemplates(wabaId: string, limit = 100): Promise<MetaTemplate[]> {
    const res = await this.get(
      `/${wabaId}/message_templates?fields=id,name,status,category,language,components,rejected_reason,quality_score&limit=${limit}`
    )
    const data = await this.parseResponse<{ data: MetaTemplate[] }>(res)
    return data.data
  }

  async getTemplate(templateId: string): Promise<MetaTemplate> {
    const res = await this.get(
      `/${templateId}?fields=id,name,status,category,language,components,rejected_reason,quality_score`
    )
    return this.parseResponse<MetaTemplate>(res)
  }

  async deleteTemplate(wabaId: string, templateName: string): Promise<void> {
    const res = await this.delete(`/${wabaId}/message_templates?name=${encodeURIComponent(templateName)}`)
    await this.parseResponse(res)
  }

  // ── Suscripción a webhooks ─────────────────────────────────────────────────

  async subscribeToWebhooks(wabaId: string): Promise<void> {
    const res = await this.post(`/${wabaId}/subscribed_apps`, {})
    await this.parseResponse(res)
  }

  async subscribeNumberFields(
    wabaId: string,
    fields: string[] = ['messages', 'history', 'smb_app_state_sync', 'smb_message_echoes'],
  ): Promise<void> {
    const res = await this.post(`/${wabaId}/subscribed_apps`, { subscribed_fields: fields })
    await this.parseResponse(res)
  }

  // ── Información del número ─────────────────────────────────────────────────

  async getPhoneNumberInfo(phoneNumberId: string): Promise<{
    id:             string
    verified_name:  string
    display_phone_number: string
    quality_rating: string
    code_verification_status: string
    name_status:    string
    platform_type:  string
    throughput:     { level: string }
  }> {
    const res = await this.get(
      `/${phoneNumberId}?fields=id,verified_name,display_phone_number,quality_rating,code_verification_status,name_status,platform_type,throughput`
    )
    return this.parseResponse(res)
  }

  async listPhoneNumbers(wabaId: string): Promise<Array<{ id: string; display_phone_number: string; verified_name: string }>> {
    const res = await this.get(`/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`)
    const data = await this.parseResponse<{ data: Array<{ id: string; display_phone_number: string; verified_name: string }> }>(res)
    return data.data
  }

  // ── Marcado de mensajes como leídos ──────────────────────────────────────

  async markAsRead(phoneNumberId: string, wamid: string): Promise<void> {
    await this.post(`/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status:            'read',
      message_id:        wamid,
    })
  }

  // ─── Helpers privados ─────────────────────────────────────────────────────

  private async get(path: string): Promise<Response> {
    return fetchWithTimeout(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
    })
  }

  private async post(path: string, body: unknown): Promise<Response> {
    return fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  }

  private async delete(path: string): Promise<Response> {
    return fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    })
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    let body: unknown
    try { body = await res.json() } catch { body = {} }

    if (!res.ok) {
      throw fromHttpResponse(res.status, body as Record<string, unknown>)
    }

    const err = (body as MetaApiError)?.error
    if (err) {
      const meta = classifyMetaError(err.code)
      if (err.code === 190) throw new TokenExpiredError()
      throw new CloudApiError(err.message, err.code, err.type, err.fbtrace_id, meta.retryable)
    }

    return body as T
  }

  // ─── Construcción del payload de mensaje para Graph API ──────────────────

  private buildMessagePayload(req: SendMessageRequest): Record<string, unknown> {
    const base: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to:                req.to,
      type:              req.type,
    }

    if (req.contextMessageId) {
      base.context = { message_id: req.contextMessageId }
    }

    switch (req.type) {
      case 'text':
        base.text = { body: req.text!.body, preview_url: req.text!.previewUrl ?? false }
        break

      case 'template':
        base.template = req.template
        break

      case 'image':
        base.image = req.image
        break

      case 'video':
        base.video = req.video
        break

      case 'audio':
        base.audio = req.audio
        break

      case 'document':
        base.document = req.document
        break

      case 'sticker':
        base.sticker = req.sticker
        break

      case 'reaction':
        base.reaction = {
          message_id: req.reaction!.messageId,
          emoji:      req.reaction!.emoji,
        }
        break

      case 'location':
        base.location = req.location
        break

      case 'interactive':
        base.interactive = req.interactive
        break
    }

    return base
  }
}
