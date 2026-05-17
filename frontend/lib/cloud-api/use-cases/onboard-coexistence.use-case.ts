// Caso de uso: onboarding de un número vía Embedded Signup con Coexistence.
// Único punto de orquestación del flujo completo.

import { cloudNumberRepository }           from '../repositories/cloud-number.repository'
import { PhoneNumberService }              from '../infrastructure/phone-number.service'
import { WebhookSubscriptionService }      from '../infrastructure/webhook-subscription.service'
import { COEXISTENCE_WEBHOOK_FIELDS }      from '../infrastructure/webhook-subscription.service'
import { exchangeCodeForToken, generateLongLivedToken } from '../infrastructure/meta-http.gateway'
import { storeToken }                      from '../token-store'
import { runInitialCoexistenceSync }       from '../coexistence-sync'
import { cloudMetrics }                    from '../infrastructure/metrics'
import type { OnboardingRequest, CloudNumberStatus } from '../types/domain'
import { CloudApiError }                   from '../errors'
import { createLogger }                    from '../infrastructure/logger'
import { createCorrelationId }             from '../correlation'
import { query }                           from '@/lib/db'

export interface OnboardingResult {
  cloudNumberId: string
  phoneNumberId: string
  displayPhone:  string
  status:        CloudNumberStatus
  message:       string
}

export class OnboardCoexistenceUseCase {
  async execute(req: OnboardingRequest, initiatedByUserId: string): Promise<OnboardingResult> {
    const appId     = process.env.META_APP_ID
    const appSecret = process.env.META_APP_SECRET
    const encKey    = process.env.TOKEN_ENCRYPTION_KEY

    if (!appId || !appSecret || !encKey) {
      throw new CloudApiError('META_APP_ID, META_APP_SECRET y TOKEN_ENCRYPTION_KEY son obligatorios')
    }

    // 1. Intercambiar code OAuth por token
    const { accessToken: shortToken } = await exchangeCodeForToken(req.code, appId, appSecret)

    // 2. Extender a token long-lived (System User no expira)
    let finalToken     = shortToken
    let tokenExpiresAt: Date | null = null

    try {
      const { accessToken: longToken, expiresIn } = await generateLongLivedToken(appId, appSecret, shortToken)
      finalToken     = longToken
      tokenExpiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null
    } catch {
      // Continuar con token corto si el refresh falla (ej: ya es System User token)
    }

    // 3. Obtener información real del número desde Meta
    const phoneSvc  = new PhoneNumberService(finalToken)
    const phoneInfo = await phoneSvc.getInfo(req.phoneNumberId)

    // 4. Persistir o actualizar en DB
    const existing = await cloudNumberRepository.findByPhoneNumberId(req.phoneNumberId)
    let cloudNumberId: string
    let resolvedLineId = req.whatsappLineId

    if (existing) {
      cloudNumberId  = existing.id
      resolvedLineId = resolvedLineId ?? existing.whatsappLineId ?? undefined
      await cloudNumberRepository.upsertForReOnboarding({
        id: cloudNumberId, wabaId: req.wabaId,
        displayPhone:  phoneInfo.display_phone_number,
        verifiedName:  phoneInfo.verified_name,
        plainToken:    finalToken, tokenExpiresAt, encryptionKey: encKey,
      })
    } else {
      cloudNumberId = await cloudNumberRepository.insert({
        wabaId:        req.wabaId,
        phoneNumberId: req.phoneNumberId,
        displayPhone:  phoneInfo.display_phone_number,
        verifiedName:  phoneInfo.verified_name,
        plainToken:    finalToken,
        tokenExpiresAt,
        whatsappLineId: resolvedLineId,
        onboardedBy:   initiatedByUserId,
        encryptionKey:  encKey,
      })
    }

    // 4b. Si no hay línea vinculada, crear una línea cloud nativa automáticamente
    if (!resolvedLineId) {
      const lineName  = phoneInfo.verified_name || phoneInfo.display_phone_number
      const ownerUid  = initiatedByUserId === 'bootstrap' ? null : initiatedByUserId
      // line_key máximo 20 chars hasta que corra migración 092 (VARCHAR(50))
      const lineKey   = `cld_${req.phoneNumberId}`.slice(0, 20)
      const newLines  = await query<{ id: string }>(
        `INSERT INTO whatsapp_lines
           (line_key, display_name, phone_number, line_type, status, is_connected, owner_user_id)
         VALUES ($1, $2, $3, 'cloud', 'active', true, $4)
         RETURNING id`,
        [lineKey, lineName, phoneInfo.display_phone_number, ownerUid],
      )
      if (newLines.length > 0) {
        resolvedLineId = newLines[0].id
        await cloudNumberRepository.linkToLine(cloudNumberId, resolvedLineId)
      }
    }

    // 5. Si el número ya está verificado (re-onboarding), activar directamente
    if (phoneInfo.code_verification_status === 'VERIFIED') {
      await this.completeActivation(req.wabaId, req.phoneNumberId, finalToken, cloudNumberId)
      cloudMetrics.numberOnboarded(req.phoneNumberId, 'direct')
      return {
        cloudNumberId, phoneNumberId: req.phoneNumberId,
        displayPhone: phoneInfo.display_phone_number,
        status: 'active',
        message: 'Número verificado y activado. Sincronización de historial iniciada.',
      }
    }

    // 6. Solicitar OTP (el cliente lo ingresa en la WA Business App)
    try {
      await phoneSvc.requestOTP(req.phoneNumberId, 'SMS')
      await cloudNumberRepository.updateStatus(req.phoneNumberId, 'code_sent')
    } catch {
      // OTP ya puede estar en curso
    }

    cloudMetrics.numberOnboarded(req.phoneNumberId, 'otp_pending')
    return {
      cloudNumberId, phoneNumberId: req.phoneNumberId,
      displayPhone: phoneInfo.display_phone_number,
      status: 'code_sent',
      message: 'Código de verificación enviado. El cliente debe ingresarlo en la WhatsApp Business App.',
    }
  }

  async verifyOTPAndActivate(
    phoneNumberId: string,
    otpCode:       string,
    accessToken:   string,
  ): Promise<OnboardingResult> {
    const phoneSvc = new PhoneNumberService(accessToken)
    await phoneSvc.verifyOTP(phoneNumberId, otpCode)

    const number = await cloudNumberRepository.findByPhoneNumberId(phoneNumberId)
    if (!number) throw new CloudApiError(`Número ${phoneNumberId} no encontrado`)

    await this.completeActivation(number.wabaId, phoneNumberId, accessToken, number.id)

    return {
      cloudNumberId: number.id, phoneNumberId,
      displayPhone:  number.displayPhone,
      status:        'active',
      message:       'Número verificado y activado. Sincronización de historial iniciada.',
    }
  }

  private async completeActivation(
    wabaId:        string,
    phoneNumberId: string,
    accessToken:   string,
    cloudNumberId: string,
  ): Promise<void> {
    // Suscribir todos los webhooks obligatorios de Coexistence
    const webhookSvc = new WebhookSubscriptionService(accessToken)
    await webhookSvc.subscribeFields(wabaId, [...COEXISTENCE_WEBHOOK_FIELDS])

    await cloudNumberRepository.updateStatus(phoneNumberId, 'active')
    await storeToken(phoneNumberId, accessToken, null)

    // Sync asíncrona: no bloquea la respuesta al usuario
    runInitialCoexistenceSync(wabaId, phoneNumberId, accessToken, 180)
      .catch(err => createLogger({ correlationId: createCorrelationId(), phoneNumberId, operation: 'onboard_sync' }).logError('initial sync failed', err))
  }
}

export const onboardCoexistenceUseCase = new OnboardCoexistenceUseCase()
