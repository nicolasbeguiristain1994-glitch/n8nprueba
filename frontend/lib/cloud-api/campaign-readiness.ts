/**
 * campaign-readiness.ts
 *
 * Diagnóstico LOCAL de líneas WhatsApp Cloud API para el módulo Campañas.
 * Sólo lee datos almacenados (SELECT); no consulta Meta, no descifra ni rota
 * tokens y no autoriza envíos. Un resultado sin bloqueos significa únicamente
 * "comprobaciones locales completas".
 *
 * Fuera de alcance: cuotas por hora/día de la línea (ver lib/line-eligibility.ts),
 * ventana de 24 h, opt-in, límites de Meta y facturación.
 */

import { query } from '@/lib/db'

const DAY_MS = 24 * 60 * 60 * 1000
export const TOKEN_EXPIRY_WARNING_DAYS = 7

// Los campos cn.* son null cuando la línea Cloud todavía no tiene número vinculado.
export interface CloudReadinessRow {
  line_id:                 string
  line_name:               string | null
  line_status:             string
  is_connected:            boolean
  sending_enabled:         boolean
  campaign_allowed:        boolean
  cloud_number_id:         string | null
  phone_number_id:         string | null
  waba_id:                 string | null
  verified_name:           string | null
  number_status:           string | null
  has_stored_token:        boolean
  token_expires_at:        Date | string | null
  last_webhook_at:         Date | string | null
  approved_template_count: number | string
}

export type CheckStatus = 'ok' | 'warning' | 'blocking' | 'info'
export type CheckKey =
  | 'active' | 'connected' | 'sending_enabled' | 'campaign_allowed'
  | 'token_present' | 'token_expiry' | 'approved_templates' | 'last_webhook'

export interface ReadinessCheck {
  key:    CheckKey
  status: CheckStatus
  label:  string
  detail: string
}

export type TokenExpiryState = 'valid' | 'expiring_soon' | 'expired' | 'unknown'
export type ReadinessSummary = 'blocked' | 'warnings' | 'local_checks_complete'

export interface CloudLineReadiness {
  line_id:                 string
  line_name:               string | null
  verified_name:           string | null
  number_linked:           boolean
  cloud_number_id:         string | null
  phone_number_id:         string | null
  waba_id:                 string | null
  token_expires_at:        string | null
  token_expiry_state:      TokenExpiryState
  token_days_remaining:    number | null
  last_webhook_at:         string | null
  approved_template_count: number
  checks:                  ReadinessCheck[]
  blocking_count:          number
  warning_count:           number
  summary:                 ReadinessSummary
}

export interface CloudReadinessResponse {
  checked_at:       string
  source:           'local_database'
  live_meta_check:  false
  lines:            CloudLineReadiness[]
}

// El valor del token nunca se selecciona: sólo un booleano de presencia.
// Sólo cuentan plantillas con ID de Meta: un borrador local no está sincronizado.
export const CLOUD_READINESS_SQL = `
  SELECT wl.id                AS line_id,
         wl.display_name      AS line_name,
         wl.status            AS line_status,
         wl.is_connected,
         wl.sending_enabled,
         (wl.allowed_types IS NULL OR wl.allowed_types @> '["campaign"]'::jsonb) AS campaign_allowed,
         cn.id                AS cloud_number_id,
         cn.phone_number_id,
         cn.waba_id,
         cn.verified_name,
         cn.status            AS number_status,
         (COALESCE(octet_length(cn.access_token_enc), 0) > 0 OR NULLIF(BTRIM(cn.access_token), '') IS NOT NULL) AS has_stored_token,
         cn.token_expires_at,
         ss.last_webhook_at,
         (SELECT COUNT(*)::int
            FROM whatsapp_templates t
           WHERE t.waba_id = cn.waba_id
             AND t.status = 'APROBADA'
             AND NULLIF(BTRIM(t.whatsapp_template_id), '') IS NOT NULL) AS approved_template_count
    FROM whatsapp_lines wl
    LEFT JOIN cloud_numbers cn ON cn.whatsapp_line_id = wl.id
    LEFT JOIN cloud_sync_state ss ON ss.phone_number_id = cn.phone_number_id
   WHERE wl.line_type = 'cloud'
     AND ($1::uuid[] IS NULL OR wl.id = ANY($1::uuid[]))
   ORDER BY wl.display_name NULLS LAST, wl.id, cn.created_at`

/** ids: null = super_admin (todas), [] = ninguna línea accesible. */
export function fetchCloudReadinessRows(ids: string[] | null): Promise<CloudReadinessRow[]> {
  return query<CloudReadinessRow>(CLOUD_READINESS_SQL, [ids])
}

function toIso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null
  const d = value instanceof Date ? value : new Date(value)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

function tokenExpiry(expiresAt: string | null, now: Date): { state: TokenExpiryState; days: number | null } {
  if (!expiresAt) return { state: 'unknown', days: null }
  const diff = new Date(expiresAt).getTime() - now.getTime()
  if (diff <= 0) return { state: 'expired', days: 0 }
  const days = Math.ceil(diff / DAY_MS)
  return { state: days <= TOKEN_EXPIRY_WARNING_DAYS ? 'expiring_soon' : 'valid', days }
}

export function evaluateCloudReadiness(row: CloudReadinessRow, now: Date): CloudLineReadiness {
  const linked = row.cloud_number_id !== null && row.cloud_number_id !== undefined
  const hasToken = linked && row.has_stored_token === true
  const tokenExpiresAt = linked ? toIso(row.token_expires_at) : null
  const lastWebhookAt = linked ? toIso(row.last_webhook_at) : null
  const approved = linked ? Number(row.approved_template_count) || 0 : 0
  const expiry = tokenExpiry(tokenExpiresAt, now)
  const checks: ReadinessCheck[] = []

  const lineActive = row.line_status === 'active'
  const numberActive = linked && row.number_status === 'active'
  checks.push({
    key: 'active',
    status: lineActive && numberActive ? 'ok' : 'blocking',
    label: 'Línea y número activos',
    detail: lineActive && numberActive
      ? 'La línea y el número Cloud figuran activos.'
      : [
          !lineActive && `La línea figura en estado "${row.line_status}".`,
          !linked
            ? 'La línea no tiene un número Cloud vinculado.'
            : !numberActive && `El número Cloud figura en estado "${row.number_status}".`,
        ].filter(Boolean).join(' '),
  })

  checks.push({
    key: 'connected',
    status: row.is_connected ? 'ok' : 'blocking',
    label: 'Línea conectada',
    detail: row.is_connected ? 'La línea figura conectada.' : 'La línea figura desconectada.',
  })

  checks.push({
    key: 'sending_enabled',
    status: row.sending_enabled ? 'ok' : 'blocking',
    label: 'Envíos habilitados',
    detail: row.sending_enabled
      ? 'La línea tiene los envíos habilitados.'
      : 'Los envíos están deshabilitados para esta línea.',
  })

  checks.push({
    key: 'campaign_allowed',
    status: row.campaign_allowed ? 'ok' : 'blocking',
    label: 'Uso para campañas',
    detail: row.campaign_allowed
      ? 'La línea admite campañas.'
      : 'La línea no admite campañas; sólo está habilitada para otros usos.',
  })

  checks.push({
    key: 'token_present',
    status: hasToken ? 'ok' : 'blocking',
    label: 'Token de acceso almacenado',
    detail: hasToken
      ? 'Hay un token almacenado. No se verificó su validez ante Meta.'
      : linked
        ? 'No hay token de acceso almacenado para este número.'
        : 'Sin número Cloud vinculado no hay token almacenado.',
  })

  const expiryCheck: Record<TokenExpiryState, Pick<ReadinessCheck, 'status' | 'detail'>> = {
    expired:       { status: 'blocking', detail: 'El token está vencido.' },
    expiring_soon: { status: 'warning',  detail: `El token vence en ${expiry.days} ${expiry.days === 1 ? 'día' : 'días'}.` },
    unknown:       { status: 'warning',  detail: 'No hay fecha de vencimiento registrada; no se asume que el token no vence.' },
    valid:         { status: 'ok',       detail: `El token vence en ${expiry.days} días.` },
  }
  checks.push({ key: 'token_expiry', label: 'Vencimiento del token', ...expiryCheck[expiry.state] })

  checks.push({
    key: 'approved_templates',
    status: approved > 0 ? 'ok' : 'blocking',
    label: 'Plantillas aprobadas sincronizadas',
    detail: approved > 0
      ? 'Hay plantillas aprobadas con ID de Meta para la cuenta (WABA) de este número.'
      : !linked
        ? 'Sin número Cloud vinculado no hay cuenta (WABA) con plantillas; las campañas con plantilla no pueden enviarse.'
        : 'No hay plantillas aprobadas sincronizadas para esta cuenta; las campañas con plantilla no pueden enviarse. Esto no evalúa respuestas dentro de la ventana de 24 h.',
  })

  // Informativo: la ausencia de webhooks recientes no es una falla.
  checks.push({
    key: 'last_webhook',
    status: 'info',
    label: 'Última recepción de webhook',
    detail: lastWebhookAt
      ? 'Dato informativo; la falta de actividad reciente no indica una falla.'
      : 'No hay recepciones de webhook registradas. Dato informativo.',
  })

  const blocking = checks.filter(c => c.status === 'blocking').length
  const warnings = checks.filter(c => c.status === 'warning').length

  return {
    line_id: row.line_id,
    line_name: row.line_name,
    verified_name: linked ? row.verified_name : null,
    number_linked: linked,
    cloud_number_id: linked ? row.cloud_number_id : null,
    phone_number_id: linked ? row.phone_number_id : null,
    waba_id: linked ? row.waba_id : null,
    token_expires_at: tokenExpiresAt,
    token_expiry_state: expiry.state,
    token_days_remaining: expiry.days,
    last_webhook_at: lastWebhookAt,
    approved_template_count: approved,
    checks,
    blocking_count: blocking,
    warning_count: warnings,
    summary: blocking > 0 ? 'blocked' : warnings > 0 ? 'warnings' : 'local_checks_complete',
  }
}

export function buildCloudReadinessResponse(rows: CloudReadinessRow[], now: Date): CloudReadinessResponse {
  return {
    checked_at: now.toISOString(),
    source: 'local_database',
    live_meta_check: false,
    lines: rows.map(row => evaluateCloudReadiness(row, now)),
  }
}
