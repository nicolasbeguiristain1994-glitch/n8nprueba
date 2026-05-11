// HTTP Gateway hacia Meta Graph API.
// Responsabilidad única: realizar llamadas HTTP autenticadas con timeout,
// circuit breaker y parseo consistente de errores.
// NADA de lógica de negocio aquí.

import { META_BASE_URL } from '../types/domain'
import type { MetaApiError } from '../types/templates'
import { CloudApiError, TokenExpiredError, fromHttpResponse, classifyMetaError } from '../errors'
import { withCircuitBreaker } from './circuit-breaker'

interface GatewayOptions {
  timeoutMs?:        number
  circuitBreakerKey?: string  // si no se pasa, no hay circuit breaker
}

export class MetaHttpGateway {
  constructor(
    private readonly accessToken: string,
    private readonly defaultOpts: GatewayOptions = {},
  ) {}

  async get<T>(path: string, opts: GatewayOptions = {}): Promise<T> {
    return this.request<T>('GET', path, undefined, opts)
  }

  async post<T>(path: string, body: unknown, opts: GatewayOptions = {}): Promise<T> {
    return this.request<T>('POST', path, body, opts)
  }

  async delete<T>(path: string, opts: GatewayOptions = {}): Promise<T> {
    return this.request<T>('DELETE', path, undefined, opts)
  }

  private async request<T>(
    method:  string,
    path:    string,
    body:    unknown,
    opts:    GatewayOptions,
  ): Promise<T> {
    const mergedOpts = { ...this.defaultOpts, ...opts }
    const timeoutMs  = mergedOpts.timeoutMs ?? 15_000

    const doFetch = () => this.fetchWithTimeout(method, path, body, timeoutMs)

    const key = mergedOpts.circuitBreakerKey
    const response = key
      ? await withCircuitBreaker(key, doFetch)
      : await doFetch()

    return this.parseResponse<T>(response)
  }

  private async fetchWithTimeout(
    method:    string,
    path:      string,
    body:      unknown,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController()
    const timer      = setTimeout(() => controller.abort(), timeoutMs)

    const init: RequestInit = {
      method,
      signal:  controller.signal,
      headers: {
        Authorization:  `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent':   'WhatsApp-Platform/1.0',
      },
    }

    if (body !== undefined) {
      init.body = JSON.stringify(body)
    }

    try {
      return await fetch(`${META_BASE_URL}${path}`, init)
    } finally {
      clearTimeout(timer)
    }
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    let body: unknown
    try { body = await res.json() } catch { body = {} }

    if (!res.ok) throw fromHttpResponse(res.status, body as Record<string, unknown>)

    const err = (body as MetaApiError)?.error
    if (err) {
      if (err.code === 190) throw new TokenExpiredError()
      const meta = classifyMetaError(err.code)
      throw new CloudApiError(err.message, err.code, err.type, err.fbtrace_id, meta.retryable)
    }

    return body as T
  }
}

// ─── Llamadas OAuth (sin token de usuario, usan App credentials) ─────────────

export async function exchangeCodeForToken(
  code:      string,
  appId:     string,
  appSecret: string,
): Promise<{ accessToken: string; tokenType: string }> {
  const url = new URL('https://graph.facebook.com/oauth/access_token')
  url.searchParams.set('client_id',     appId)
  url.searchParams.set('client_secret', appSecret)
  url.searchParams.set('code',          code)

  const res  = await fetch(url.toString(), { headers: { 'User-Agent': 'WhatsApp-Platform/1.0' } })
  const body = await res.json() as { access_token?: string; token_type?: string } & MetaApiError

  if (!res.ok || !body.access_token) {
    throw new CloudApiError(
      body.error?.message ?? 'Error al intercambiar código OAuth',
      body.error?.code,
    )
  }

  return { accessToken: body.access_token, tokenType: body.token_type ?? 'bearer' }
}

export async function generateLongLivedToken(
  appId:           string,
  appSecret:       string,
  shortLivedToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const url = new URL(`https://graph.facebook.com/${META_BASE_URL.split('/').pop()}/oauth/access_token`)
  url.searchParams.set('grant_type',        'fb_exchange_token')
  url.searchParams.set('client_id',         appId)
  url.searchParams.set('client_secret',     appSecret)
  url.searchParams.set('fb_exchange_token', shortLivedToken)

  const res  = await fetch(url.toString(), { headers: { 'User-Agent': 'WhatsApp-Platform/1.0' } })
  const body = await res.json() as { access_token?: string; expires_in?: number } & MetaApiError

  if (!res.ok || !body.access_token) {
    throw new CloudApiError(body.error?.message ?? 'Error al generar token long-lived')
  }

  return { accessToken: body.access_token, expiresIn: body.expires_in ?? 0 }
}
