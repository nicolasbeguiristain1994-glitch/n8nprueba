import { query } from '@/lib/db'
import { MetaCloudApiClient } from './client'
import { runInitialCoexistenceSync } from './coexistence-sync'
import { storeToken } from './token-store'
import type { OnboardingRequest, CloudNumberStatus } from './types'
import { CloudApiError } from './errors'
import { createLogger } from './infrastructure/logger'

const signupLog = createLogger({ correlationId: 'system', operation: 'embedded_signup' })

// ─── Flujo completo de onboarding con Coexistence ────────────────────────────
//
// Paso 1: El frontend llama FB.login() con featureType = 'whatsapp_business_app_onboarding'
//         El usuario da permisos y Meta llama al callback con:
//           { authResponse: { code, waba_id, phone_number_id } }
//
// Paso 2: El frontend envía ese code + waba_id + phone_number_id a POST /api/cloud/onboard
//
// Paso 3: Aquí intercambiamos el code por un token, registramos el número,
//         pedimos OTP y guardamos todo en DB con status = 'code_sent'
//
// Paso 4: El usuario ingresa el OTP en la WA Business App (no en nuestra plataforma)
//         Meta lo procesa automáticamente. Cuando está verificado, suscribimos webhooks
//         y lanzamos la sync de historial.

export interface OnboardingResult {
  cloudNumberId: string
  phoneNumberId: string
  displayPhone:  string
  status:        CloudNumberStatus
  message:       string
}

export async function startCoexistenceOnboarding(
  req: OnboardingRequest,
  initiatedByUserId: string,
): Promise<OnboardingResult> {
  const appId     = process.env.META_APP_ID!
  const appSecret = process.env.META_APP_SECRET!

  if (!appId || !appSecret) {
    throw new CloudApiError('META_APP_ID y META_APP_SECRET son obligatorios')
  }

  // ── Paso 1: Intercambiar code por access token ────────────────────────────
  signupLog.logInfo('exchanging code for token', { phoneNumberId: req.phoneNumberId })
  const { accessToken } = await MetaCloudApiClient.exchangeCodeForToken(req.code, appId, appSecret)

  // ── Paso 2: Generar System User token long-lived (no expira) ─────────────
  // IMPORTANTE: el code solo vale para un intercambio. Hacemos el refresh inmediatamente.
  let finalToken = accessToken
  let tokenExpiresAt: Date | null = null

  try {
    const { accessToken: longLived, expiresIn } = await MetaCloudApiClient.generateSystemUserToken(
      appId,
      appSecret,
      accessToken,
    )
    finalToken = longLived
    tokenExpiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null
  } catch (err) {
    // Si falla el refresh (ej: no es un user token), continuar con el token corto
    signupLog.logWarn('could not extend token lifetime', { error: String(err) })
  }

  const client = new MetaCloudApiClient(finalToken)

  // ── Paso 3: Obtener información del número de Meta ─────────────────────────
  const phoneInfo = await client.getPhoneNumberInfo(req.phoneNumberId)

  // ── Paso 4: Persistir número en DB ───────────────────────────────────────
  const existing = await query<{ id: string; status: string }>(
    `SELECT id, status FROM cloud_numbers WHERE phone_number_id = $1`,
    [req.phoneNumberId],
  )

  let cloudNumberId: string

  if (existing.length > 0) {
    cloudNumberId = existing[0].id
    // Actualizar token si el número ya existía
    await query(
      `UPDATE cloud_numbers
       SET waba_id = $1, access_token = $2, token_expires_at = $3,
           verified_name = $4, display_phone = $5,
           status = 'pending', contacts_synced = false, history_synced = false,
           updated_at = NOW()
       WHERE id = $6`,
      [req.wabaId, finalToken, tokenExpiresAt, phoneInfo.verified_name, phoneInfo.display_phone_number, cloudNumberId],
    )
  } else {
    const result = await query<{ id: string }>(
      `INSERT INTO cloud_numbers
         (waba_id, phone_number_id, display_phone, verified_name, access_token,
          token_expires_at, status, coexistence_enabled, whatsapp_line_id, onboarded_by, onboarded_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', true, $7, $8, NOW())
       RETURNING id`,
      [
        req.wabaId,
        req.phoneNumberId,
        phoneInfo.display_phone_number,
        phoneInfo.verified_name,
        finalToken,
        tokenExpiresAt,
        req.whatsappLineId ?? null,
        initiatedByUserId,
      ],
    )
    cloudNumberId = result[0].id
  }

  // ── Paso 5: Verificar estado del número en Meta ───────────────────────────
  const verificationStatus = phoneInfo.code_verification_status

  if (verificationStatus === 'VERIFIED') {
    // El número ya está verificado (re-onboarding)
    await completeVerification(req.wabaId, req.phoneNumberId, finalToken, cloudNumberId)
    return {
      cloudNumberId,
      phoneNumberId: req.phoneNumberId,
      displayPhone:  phoneInfo.display_phone_number,
      status:        'active',
      message:       'Número verificado y activado correctamente',
    }
  }

  // ── Paso 6: Solicitar OTP para verificación (números nuevos) ─────────────
  // Con Coexistence, el OTP se ingresa en la WhatsApp Business App del cliente,
  // NO en nuestra plataforma. Sin embargo, debemos solicitar el envío del OTP.
  try {
    await client.requestOTP(req.phoneNumberId, 'SMS')
    await query(
      `UPDATE cloud_numbers SET status = 'code_sent', updated_at = NOW() WHERE id = $1`,
      [cloudNumberId],
    )
    signupLog.logInfo('OTP requested', { phoneNumberId: req.phoneNumberId })
  } catch (err) {
    signupLog.logWarn('OTP request failed (may already be verified)', { error: String(err) })
  }

  return {
    cloudNumberId,
    phoneNumberId: req.phoneNumberId,
    displayPhone:  phoneInfo.display_phone_number,
    status:        'code_sent',
    message:       'Código de verificación enviado. El cliente debe ingresarlo en la WhatsApp Business App.',
  }
}

// ─── Verificar OTP manualmente (si el cliente lo proporciona) ────────────────

export async function verifyOTPAndActivate(
  phoneNumberId: string,
  otpCode:       string,
  accessToken:   string,
): Promise<OnboardingResult> {
  const client = new MetaCloudApiClient(accessToken)
  await client.verifyOTP(phoneNumberId, otpCode)

  const result = await query<{ id: string; waba_id: string; display_phone: string }>(
    `SELECT id, waba_id, display_phone FROM cloud_numbers WHERE phone_number_id = $1`,
    [phoneNumberId],
  )
  const row = result[0]
  if (!row) throw new CloudApiError(`Número ${phoneNumberId} no encontrado en la plataforma`)

  await completeVerification(row.waba_id, phoneNumberId, accessToken, row.id)

  return {
    cloudNumberId: row.id,
    phoneNumberId,
    displayPhone:  row.display_phone,
    status:        'active',
    message:       'Número verificado y activado. Sincronización de historial iniciada.',
  }
}

// ─── Completar verificación: suscribir webhooks + lanzar sync ────────────────

async function completeVerification(
  wabaId:        string,
  phoneNumberId: string,
  accessToken:   string,
  cloudNumberId: string,
): Promise<void> {
  const client = new MetaCloudApiClient(accessToken)

  // Suscribir la app a los webhooks del WABA
  // Incluye los campos específicos de Coexistence obligatorios
  await client.subscribeNumberFields(wabaId, [
    'messages',            // mensajes entrantes y estados de envío
    'history',             // sincronización de historial completada
    'smb_app_state_sync',  // sincronización de contactos de la WA Business App
    'smb_message_echoes',  // mensajes enviados desde la WA Business App (eco)
    'message_template_status_update', // aprobación/rechazo de plantillas
    'phone_number_quality_update',    // cambios de calidad del número
  ])

  // Actualizar estado a active
  await query(
    `UPDATE cloud_numbers SET status = 'active', updated_at = NOW() WHERE id = $1`,
    [cloudNumberId],
  )

  await storeToken(phoneNumberId, accessToken, null)

  // Iniciar sincronización asíncrona de historial y contactos
  // Esto no bloquea el onboarding — Meta notificará via webhook cuando complete
  runInitialCoexistenceSync(wabaId, phoneNumberId, accessToken, 180)
    .then(() => signupLog.logInfo('coexistence sync started', { phoneNumberId }))
    .catch(err => signupLog.logError('coexistence sync failed', err, { phoneNumberId }))
}
