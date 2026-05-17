// Caso de uso: crear un inbox de WhatsApp Cloud en Chatwoot para un número ya onboardeado.

import { cloudNumberRepository } from '../repositories/cloud-number.repository'
import { CloudApiError }         from '../errors'
import { getTokenForNumber }      from '../token-store'

export interface CreateChatwootInboxResult {
  inboxId:   string
  inboxName: string
}

export class CreateChatwootInboxUseCase {
  async execute(phoneNumberId: string): Promise<CreateChatwootInboxResult> {
    const apiUrl    = process.env.CHATWOOT_API_URL
    const apiKey    = process.env.CHATWOOT_API_KEY
    const accountId = process.env.CHATWOOT_ACCOUNT_ID

    if (!apiUrl || !apiKey || !accountId) {
      throw new CloudApiError('CHATWOOT_API_URL, CHATWOOT_API_KEY y CHATWOOT_ACCOUNT_ID son obligatorios')
    }

    const number = await cloudNumberRepository.findByPhoneNumberId(phoneNumberId)
    if (!number) throw new CloudApiError(`Número ${phoneNumberId} no encontrado`)
    if (number.status !== 'active') throw new CloudApiError('El número debe estar activo para crear un inbox')
    if (number.chatwootInboxId) throw new CloudApiError('Este número ya tiene un inbox en Chatwoot')

    const accessToken = await getTokenForNumber(phoneNumberId).catch(() => null)
    if (!accessToken) throw new CloudApiError('Token de acceso no disponible para este número')

    const inboxName = number.verifiedName || number.displayPhone

    const res = await fetch(`${apiUrl}/api/v1/accounts/${accountId}/inboxes`, {
      method: 'POST',
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
      const body = await res.text().catch(() => '')
      throw new CloudApiError(`Chatwoot respondió ${res.status}: ${body}`)
    }

    const data = await res.json() as { id: number | string; name: string }
    const inboxId = String(data.id)

    await cloudNumberRepository.setChatwootInbox(phoneNumberId, inboxId, inboxName)

    return { inboxId, inboxName }
  }
}

export const createChatwootInboxUseCase = new CreateChatwootInboxUseCase()
