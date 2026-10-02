// Caso de uso: crear un inbox de WhatsApp Cloud en Chatwoot para un número ya onboardeado.

import { cloudNumberRepository } from '../repositories/cloud-number.repository'
import { CloudApiError }         from '../errors'
import { getTokenForNumber }      from '../token-store'
import { isChatwootConfigured }   from '../chatwoot-config'

export interface CreateChatwootInboxResult {
  inboxId:   string
  inboxName: string
}

// Chatwoot es opcional: sin configuración no se hace ninguna llamada externa.
export class ChatwootNotConfiguredError extends Error {
  readonly code = 'CHATWOOT_NOT_CONFIGURED' as const
  constructor() {
    super('Chatwoot no está configurado')
    this.name = 'ChatwootNotConfiguredError'
  }
}

export class CreateChatwootInboxUseCase {
  async execute(phoneNumberId: string): Promise<CreateChatwootInboxResult> {
    if (!isChatwootConfigured()) throw new ChatwootNotConfiguredError()

    const apiUrl    = process.env.CHATWOOT_API_URL!.trim()
    const apiKey    = process.env.CHATWOOT_API_KEY!.trim()
    const accountId = process.env.CHATWOOT_ACCOUNT_ID!.trim()

    const number = await cloudNumberRepository.findByPhoneNumberId(phoneNumberId)
    if (!number) throw new CloudApiError(`Número ${phoneNumberId} no encontrado`)
    if (number.status !== 'active') throw new CloudApiError('El número debe estar activo para crear un inbox')
    if (number.chatwootInboxId) throw new CloudApiError('Este número ya tiene un inbox en Chatwoot')

    const accessToken = await getTokenForNumber(phoneNumberId).catch(() => null)
    if (!accessToken) throw new CloudApiError('Token de acceso no disponible para este número')

    const inboxName = number.verifiedName || number.displayPhone

    const res = await fetch(`${apiUrl}/api/v1/accounts/${accountId}/inboxes`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        'api_access_token': apiKey,
      },
      body: JSON.stringify({
        name:         inboxName,
        channel: {
          type:                'whatsapp',
          phone_number:        number.displayPhone,
          provider:            'whatsapp_cloud',
          provider_config: {
            phone_number_id:      number.phoneNumberId,
            business_account_id:  number.wabaId,
            api_key:              accessToken,
          },
        },
      }),
    })

    if (!res.ok) {
      throw new CloudApiError(`Chatwoot respondió ${res.status}`)
    }

    const data = await res.json() as { id: number | string; name: string }
    const inboxId = String(data.id)

    await cloudNumberRepository.setChatwootInbox(phoneNumberId, inboxId, inboxName)

    return { inboxId, inboxName }
  }
}

export const createChatwootInboxUseCase = new CreateChatwootInboxUseCase()
