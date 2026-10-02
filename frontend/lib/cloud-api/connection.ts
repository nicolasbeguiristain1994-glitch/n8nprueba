import { z } from 'zod'
import { withTransaction } from '@/lib/db'
import { MetaHttpGateway } from './infrastructure/meta-http.gateway'
import { PhoneNumberService } from './infrastructure/phone-number.service'
import { CloudApiError } from './errors'

const metaId = z.string().regex(/^\d{5,30}$/)
export const DirectConnectionSchema = z.object({
  appId: metaId, wabaId: metaId, phoneNumberId: metaId,
  accessToken: z.string().min(20).max(4096),
  register: z.boolean().default(false),
  pin: z.string().regex(/^\d{6}$/).optional(),
}).strict().refine(v => !v.register || !!v.pin, { message: 'El registro requiere el PIN de seis dígitos.', path: ['pin'] })

export function cloudConfiguration() {
  return {
    appId: process.env.META_APP_ID || '',
    checks: {
      appId: /^\d+$/.test(process.env.META_APP_ID || ''),
      appSecret: !!process.env.META_APP_SECRET && process.env.META_APP_SECRET !== 'replace-me',
      verifyToken: !!process.env.META_WEBHOOK_VERIFY_TOKEN && !process.env.META_WEBHOOK_VERIFY_TOKEN.startsWith('replace-'),
      encryptionKey: (process.env.TOKEN_ENCRYPTION_KEY?.length ?? 0) >= 32 && !process.env.TOKEN_ENCRYPTION_KEY?.startsWith('replace-'),
    },
  }
}

// Validate the supplied token against this app and prove phone membership in the WABA.
export async function validateCloudAssets(token: string, appId: string, wabaId: string, phoneNumberId: string) {
  const appSecret = process.env.META_APP_SECRET
  if (!appSecret || appId !== process.env.META_APP_ID) throw new CloudApiError('El App ID debe coincidir con la aplicación configurada en el servidor.')
  const debug = await new MetaHttpGateway(`${appId}|${appSecret}`).get<{ data: {
    is_valid: boolean; app_id: string; scopes?: string[]; expires_at?: number; data_access_expires_at?: number
  } }>(`/debug_token?input_token=${encodeURIComponent(token)}`)
  const info = debug.data
  const now = Math.floor(Date.now() / 1000)
  if (!info?.is_valid || info.app_id !== appId || [info.expires_at, info.data_access_expires_at].some(t => t && t <= now)) throw new CloudApiError('El token es inválido, venció o pertenece a otra aplicación.')
  for (const scope of ['whatsapp_business_management', 'whatsapp_business_messaging']) {
    if (!info.scopes?.includes(scope)) throw new CloudApiError(`Falta el permiso ${scope} en el token.`)
  }
  const gw = new MetaHttpGateway(token)
  let after: string | undefined
  const seen = new Set<string>()
  let found = false
  do {
    const page = await gw.get<{ data: { id: string }[]; paging?: { cursors?: { after?: string }; next?: string } }>(
      `/${wabaId}/phone_numbers?fields=id&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`,
    )
    if (page.data?.some(p => p.id === phoneNumberId)) { found = true; break }
    after = page.paging?.next ? page.paging.cursors?.after : undefined
    if (after && seen.has(after)) throw new CloudApiError('No se pudo verificar la lista de números de Meta.')
    if (after) seen.add(after)
  } while (after)
  if (!found) throw new CloudApiError('El Phone Number ID no pertenece a la WABA indicada o el token no tiene acceso.')
  const expiry = [info.expires_at, info.data_access_expires_at].filter((v): v is number => !!v && v > 0)
  return expiry.length ? new Date(Math.min(...expiry) * 1000) : null
}

export async function connectDirectNumber(input: z.infer<typeof DirectConnectionSchema>, userId: string) {
  if (!Object.values(cloudConfiguration().checks).every(Boolean)) throw new CloudApiError('Falta completar la configuración de Meta y cifrado en el servidor.')
  const expiresAt = await validateCloudAssets(input.accessToken, input.appId, input.wabaId, input.phoneNumberId)
  const svc = new PhoneNumberService(input.accessToken)
  let phone = await svc.getInfo(input.phoneNumberId)
  if (phone.code_verification_status !== 'VERIFIED') throw new CloudApiError('Primero verificá el número por SMS o llamada en WhatsApp Manager.')
  if (input.register) {
    await svc.register(input.phoneNumberId, input.pin!)
    phone = await svc.getInfo(input.phoneNumberId)
  }
  if (phone.platform_type !== 'CLOUD_API' || phone.status !== 'CONNECTED') throw new CloudApiError('El número todavía no está conectado a Cloud API. Completá su registro con el PIN de verificación en dos pasos.')
  const subscription = await new MetaHttpGateway(input.accessToken).post<{ success: boolean }>(`/${input.wabaId}/subscribed_apps`, {})
  if (subscription.success !== true) throw new CloudApiError('Meta no confirmó la suscripción de la aplicación a la WABA.')
  const result = await withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`cloud-connect:${input.phoneNumberId}`])
    const existing = await client.query<{ id: string; whatsapp_line_id: string | null }>('SELECT id, whatsapp_line_id FROM cloud_numbers WHERE phone_number_id=$1 FOR UPDATE', [input.phoneNumberId])
    let lineId = existing.rows[0]?.whatsapp_line_id
    if (!lineId) {
      const line = await client.query<{ id: string }>(`INSERT INTO whatsapp_lines (line_key, display_name, phone_number, line_type, status, is_connected, sending_enabled, owner_user_id)
        VALUES ($1,$2,$3,'cloud','active',true,false,$4) RETURNING id`,
        [`cld_${input.phoneNumberId}`, phone.verified_name || phone.display_phone_number, phone.display_phone_number, userId === 'bootstrap' ? null : userId])
      lineId = line.rows[0].id
    }
    const saved = await client.query<{ id: string }>(`INSERT INTO cloud_numbers
      (waba_id,phone_number_id,display_phone,verified_name,access_token,access_token_enc,token_expires_at,status,coexistence_enabled,whatsapp_line_id,onboarded_by,onboarded_at)
      VALUES ($1,$2,$3,$4,'',pgp_sym_encrypt($5,$6),$7,'active',false,$8,$9,NOW())
      ON CONFLICT(phone_number_id) DO UPDATE SET waba_id=EXCLUDED.waba_id, display_phone=EXCLUDED.display_phone,
      verified_name=EXCLUDED.verified_name, access_token='',access_token_enc=EXCLUDED.access_token_enc,
      token_expires_at=EXCLUDED.token_expires_at,status='active',whatsapp_line_id=EXCLUDED.whatsapp_line_id,updated_at=NOW() RETURNING id`,
      [input.wabaId,input.phoneNumberId,phone.display_phone_number,phone.verified_name,input.accessToken,process.env.TOKEN_ENCRYPTION_KEY,expiresAt,lineId,userId === 'bootstrap' ? null : userId])
    await client.query("UPDATE whatsapp_lines SET line_type='cloud',status='active',is_connected=true WHERE id=$1",[lineId])
    return { cloudNumberId: saved.rows[0].id, lineId }
  })
  return { ...result, phoneNumberId: input.phoneNumberId, displayPhone: phone.display_phone_number, status: 'active', message: 'Conexión validada con Meta. Probá recepción y envío antes de habilitar esta línea para campañas.' }
}
