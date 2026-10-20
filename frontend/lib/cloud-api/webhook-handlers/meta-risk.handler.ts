import { query } from '@/lib/db'
import { raiseRiskIncident, clearMetaRiskSignal } from '@/lib/campaign-risk'
import type { WebhookAccountUpdate, WebhookTemplateQualityUpdate, WebhookTemplateStatusUpdate } from '../types/webhooks'

// Meta reference verified 2026-10-19. Quality changes are WABA-level events:
// https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update
// https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_quality_update
// phone_number_quality_update currently describes throughput, not quality colors.
export function webhookObservedAt(time?: number): string | undefined {
  if (typeof time !== 'number' || !Number.isFinite(time) || time <= 0) return undefined
  const date = new Date(time * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

export async function applyPhoneQualityRisk(phoneNumberId: string, quality: string, observedAt: string): Promise<void> {
  const scope = { scopeType: 'phone' as const, scopeId: phoneNumberId, observedAt }
  if (quality === 'YELLOW' || quality === 'RED') {
    await raiseRiskIncident({ ...scope, source: 'meta', signal: 'meta_phone_quality',
      title: `Calidad ${quality === 'RED' ? 'baja' : 'media'} de la línea en Meta`,
      detail: 'Pausa preventiva por la calidad informada por Meta. Revisá audiencia, consentimiento y contenido antes de reanudar.',
      metrics: { quality },
    })
  } else if (quality === 'GREEN') {
    await clearMetaRiskSignal({ ...scope, signals: ['meta_phone_quality'] })
  }
  // UNKNOWN/NA means pending, not proof that an earlier warning disappeared.
}

export type MetaHealthStatus = {
  can_send_message: 'AVAILABLE' | 'LIMITED' | 'BLOCKED'
  entities: Array<{ entity_type: string; id: string; can_send_message: 'AVAILABLE' | 'LIMITED' | 'BLOCKED';
    errors?: Array<{ error_code?: number; error_description?: string }> }>
}

// https://developers.facebook.com/documentation/business-messaging/whatsapp/support/health-status
// Use messaging health only: calling/SIP restrictions do not prohibit messages.
export async function applyPhoneHealthRisk(phoneNumberId: string, wabaId: string, health: MetaHealthStatus, observedAt: string): Promise<void> {
  const phone = health.entities.find(e => e.entity_type === 'PHONE_NUMBER' && e.id === phoneNumberId)
  const waba = health.entities.find(e => e.entity_type === 'WABA' && e.id === wabaId)
  if (!phone || !waba || !health.entities.some(e => e.entity_type === 'APP') || !health.entities.some(e => e.entity_type === 'BUSINESS')
    || !['AVAILABLE', 'LIMITED', 'BLOCKED'].includes(health.can_send_message)
    || health.entities.some(e => !['AVAILABLE', 'LIMITED', 'BLOCKED'].includes(e.can_send_message))) {
    throw new Error('Meta no devolvió la salud de mensajería de la línea y su cuenta')
  }
  const blockedAccount = health.entities.filter(e => ['WABA', 'BUSINESS', 'APP'].includes(e.entity_type) && e.can_send_message === 'BLOCKED')
  if (blockedAccount.length) {
    await raiseRiskIncident({ scopeType: 'waba', scopeId: wabaId, source: 'meta', signal: 'meta_account_health', observedAt,
      title: 'Meta informa un bloqueo de mensajería de la cuenta',
      detail: 'La verificación oficial de salud impide enviar mensajes. Revisá la cuenta, el negocio y los permisos en Meta antes de reanudar.',
      metrics: { health: health.can_send_message, entities: blockedAccount.map(e => ({ type: e.entity_type, errors: e.errors?.map(error => error.error_code) })) },
    })
  } else if (health.entities.filter(e => ['WABA', 'BUSINESS', 'APP'].includes(e.entity_type)).every(e => e.can_send_message === 'AVAILABLE')) {
    await clearMetaRiskSignal({ scopeType: 'waba', scopeId: wabaId, signals: ['meta_account_health'], observedAt })
  }
  if (phone.can_send_message === 'BLOCKED') {
    await raiseRiskIncident({ scopeType: 'phone', scopeId: phoneNumberId, source: 'meta', signal: 'meta_phone_health', observedAt,
      title: 'Meta informa un bloqueo de mensajería de la línea',
      detail: 'La verificación oficial de salud impide enviar mensajes desde esta línea. Revisá su configuración y los errores en Meta.',
      metrics: { health: phone.can_send_message, errors: phone.errors?.map(error => error.error_code) },
    })
  } else if (phone.can_send_message === 'AVAILABLE') {
    await clearMetaRiskSignal({ scopeType: 'phone', scopeId: phoneNumberId, signals: ['meta_phone_health'], observedAt })
  }
  // LIMITED may only mean an unapproved display name. It is not proof of a ban
  // and is not sufficient evidence to clear a previous BLOCKED observation.
}

export async function handleTemplateQualityRisk(update: WebhookTemplateQualityUpdate, wabaId: string, observedAt?: string): Promise<void> {
  if (typeof update.message_template_name !== 'string' || !update.message_template_name) return
  const scope = { scopeType: 'template' as const, scopeId: `${wabaId}:${update.message_template_name}`, observedAt }
  const quality = update.new_quality_score
  if (quality === 'YELLOW' || quality === 'RED') {
    await raiseRiskIncident({ ...scope, source: 'meta', signal: 'meta_template_quality',
      title: `Calidad ${quality === 'RED' ? 'baja' : 'media'} de la plantilla`,
      detail: `Meta informó calidad ${quality} para ${update.message_template_name}. Las campañas quedan pausadas preventivamente.`,
      metrics: { quality, previousQuality: update.previous_quality_score, templateName: update.message_template_name },
    })
  } else if (quality === 'GREEN') {
    await clearMetaRiskSignal({ ...scope, signals: ['meta_template_quality'] })
  }
}

export async function handleTemplateStatusRisk(update: WebhookTemplateStatusUpdate, wabaId: string, observedAt?: string): Promise<void> {
  if (typeof update.message_template_name !== 'string' || !update.message_template_name) return
  const scope = { scopeType: 'template' as const, scopeId: `${wabaId}:${update.message_template_name}`, observedAt }
  if (['FLAGGED', 'PAUSED', 'DISABLED', 'REJECTED', 'DELETED', 'PENDING_DELETION', 'ARCHIVED'].includes(update.event)) {
    await raiseRiskIncident({ ...scope, source: 'meta', signal: 'meta_template_status',
      title: 'Meta restringió o advirtió sobre una plantilla',
      detail: `La plantilla ${update.message_template_name} tiene estado ${update.event}. Revisá el motivo en Meta antes de reanudar.`,
      metrics: { status: update.event, reason: update.reason ?? null, templateName: update.message_template_name },
    })
  } else if (update.event === 'APPROVED' || update.event === 'REINSTATED') {
    await clearMetaRiskSignal({ ...scope, signals: ['meta_template_status'] })
  }
}

export async function handleAccountRisk(update: WebhookAccountUpdate, wabaId: string, observedAt?: string): Promise<void> {
  // Signature and app/WABA assignment are checked by the dispatcher. An unknown
  // WABA is never allowed to create a hold, even on the legacy app callback.
  const known = await query<{ phone_number_id: string; display_phone: string }>(
    `SELECT phone_number_id, display_phone FROM cloud_numbers WHERE waba_id = $1`, [wabaId],
  )
  if (!known.length) return
  const digits = typeof update.phone_number === 'string' ? update.phone_number.replace(/\D/g, '') : ''
  const matching = digits ? known.filter(n => n.display_phone.replace(/\D/g, '') === digits) : []
  const scope = matching.length === 1
    ? { scopeType: 'phone' as const, scopeId: matching[0].phone_number_id, observedAt }
    : { scopeType: 'waba' as const, scopeId: wabaId, observedAt }
  const raise = (signal: string, title: string, detail: string, metrics: Record<string, unknown> = {}) =>
    raiseRiskIncident({ ...scope, source: 'meta', signal, title, detail, metrics: { event: update.event, ...metrics } })

  if (update.event === 'ACCOUNT_VIOLATION') {
    await raise('meta_account_violation', 'Meta detectó una infracción de la cuenta',
      'Se pausaron las campañas afectadas. Revisá la infracción en el administrador de Meta.',
      { violationType: update.violation_info?.violation_type })
  } else if (update.event === 'ACCOUNT_RESTRICTION') {
    if (Array.isArray(update.restriction_info) && update.restriction_info.length === 0) {
      await clearMetaRiskSignal({ ...scope, signals: ['meta_account_restriction'] })
    } else {
      await raise('meta_account_restriction', 'Meta restringió la cuenta',
        'Se pausaron preventivamente las campañas afectadas por una restricción oficial.',
        { restrictions: update.restriction_info?.map(r => ({ type: r.restriction_type, expiration: r.expiration })) })
    }
  } else if (update.event === 'DISABLED_UPDATE') {
    const state = update.ban_info?.waba_ban_state
    if (state === 'REINSTATE') {
      await clearMetaRiskSignal({ ...scope, signals: ['meta_account_disabled', 'meta_account_restriction', 'meta_account_violation'] })
    } else if (state === 'DISABLE' || state === 'SCHEDULE_FOR_DISABLE') {
      await raise('meta_account_disabled', state === 'DISABLE' ? 'Meta deshabilitó la cuenta' : 'Meta anunció una deshabilitación',
        'Las campañas permanecen detenidas. La reactivación requiere revisión de la cuenta y confirmación manual en el panel.', { banState: state })
    }
  } else if (['ACCOUNT_DELETED', 'ACCOUNT_OFFBOARDED', 'PARTNER_REMOVED', 'PARTNER_APP_UNINSTALLED'].includes(update.event)) {
    await raise('meta_account_connection', 'Se perdió la conexión de la cuenta con Meta',
      'Las campañas quedaron detenidas. Revisá la conexión y los permisos antes de reanudar.')
  } else if (update.event === 'ACCOUNT_RECONNECTED') {
    await clearMetaRiskSignal({ ...scope, signals: ['meta_account_connection'] })
  }
}
