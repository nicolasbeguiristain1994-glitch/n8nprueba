/**
 * campaign-distributor.ts
 *
 * Multi-line, multi-provider campaign distribution domain logic.
 *
 * Source of truth: campaign_recipients
 *   Each row is one dispatch unit. Status lifecycle:
 *   pending → sending → sent | failed | skipped
 *   Retryable failures reset to pending (line_id cleared) up to MAX_RETRIES.
 *
 * Send paths:
 *   - line_type = 'evolution': direct Evolution API (per-line URL + instance key).
 *     POST {line.evolution_url}/message/sendText/{line.evolution_instance}
 *     Body: { number, text } | { number, mediaMessage: { mediatype, media, caption } }
 *
 *   - line_type = 'cloud': WhatsApp Cloud API (Graph API) via MessageSenderService.
 *     Requires a phone_number_id and an encrypted per-number access token.
 *     Rate limited to 20 msg/s per number (enforced by enforceRateLimit).
 *
 * Concurrency: same atomic claim pattern for both providers —
 *   UPDATE … WHERE status='pending' … FOR UPDATE SKIP LOCKED RETURNING.
 *   Only one processor can claim a given unit at a time.
 *
 * Double-send protection:
 *   1. Claim atomically — unit moves to 'sending' before any API call.
 *   2. Pre-insert 'queued' row in whatsapp_messages before the provider call.
 *   3. On success: UPDATE whatsapp_messages WHERE status='queued' → 'sent'.
 *      campaign_recipients marked 'sent' only after this succeeds.
 *   4. Stale recovery (recoverStaleUnits) resolves any half-sent state on restart.
 *   5. A 'sent' recipient can never be claimed again (claimNextUnit filters pending).
 */

import { query } from '@/lib/db'
import { distributorVisibilityClause } from '@/lib/line-visibility'
import { humanLikeDelay, buildDelayConfig } from '@/lib/anti-ban-delays'
import { clog } from '@/lib/campaign-logger'
import {
  getLinePersonality,
  getLoadedPersonality,
  hydratePersonalityFromRecord,
  shouldLineBeActiveNow,
  getAdjustedDelayConfig,
  updateLastActiveAt,
  savePersonalityToDB,
  evictPersonality,
  getLoadedLineIds,
} from '@/lib/line-personality'
import {
  getProxyForLine,
  reportProxySendFailure,
  flushExpiredBlacklist,
} from '@/lib/proxy-manager'
import { ContactFrequencyEngine } from '@/lib/contact-frequency/ContactFrequencyEngine'
import { lineEligibleExpr, cloudEligibleExpr } from '@/lib/line-eligibility'
import { enforceRateLimit } from '@/lib/cloud-api/rate-limiter'
import { getTokenForNumber } from '@/lib/cloud-api/token-store'
import { MessageSenderService } from '@/lib/cloud-api/infrastructure/message-sender.service'
import { CloudApiError } from '@/lib/cloud-api/errors'
import type { SendMessageRequest, TemplateContent, TemplateParameter } from '@/lib/cloud-api/types/messages'

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_RETRIES            = 3   // permanent failure after this many attempts
const STALE_SENDING_MINUTES  = 15  // reclaim stuck 'sending' rows after this
const PROCESSOR_LOCK_MINUTES = 30  // stale processor lock timeout

const LOCK_HEARTBEAT_EVERY   = 50  // refresh processor_locked_at every N sends

// Cloud API error codes that are contact-level and non-retryable → 'skipped'.
// These come from MetaHttpGateway as CloudApiError, not from the use-case layer.
// 131021: number not on WhatsApp
// 131026: recipient opted out of business messages
// 131047: 24h conversation window closed (free-form text requires open session)
const CLOUD_SKIP_CODES = new Set([131021, 131026, 131047])

// ── Types ──────────────────────────────────────────────────────────────────────

export type EligibleLine = {
  id:                 string
  line_type:          'evolution' | 'cloud'
  phone_number_id:    string | null   // cloud lines only
  evolution_instance: string | null   // evolution lines only
  evolution_url:      string | null   // evolution lines only
  msgs_sent_hour:     number
  msgs_sent_today:    number
  msg_per_hour:       number
  msg_per_day:        number
  priority:           number
  last_seen_at:       string | null
  remaining_hour:     number
  remaining_day:      number
  has_personality:    boolean
}

// Schema del JSONB campaigns.template_params.
// Los valores de body pueden contener {{first_name}} o {{phone_number}}.
export type CampaignTemplateParams = {
  body?:    string[]   // vars posicionales → {{1}}, {{2}} … del componente body
  header?:  { type: 'image' | 'video' | 'document'; link: string }
  buttons?: Array<{ index: number; sub_type: 'url' | 'quick_reply'; payload: string }>
}

export type CampaignForDispatch = {
  id:                  string
  name:                string
  message:             string
  messages:            string[] | null
  media_url:           string | null
  list_id:             string
  antiblock_delay_min: number
  antiblock_delay_max: number
  personalize_name:    boolean
  status:              string
  owned_by:            string | null
  // Template support (message_type = 'template' → Cloud API únicamente)
  message_type:      'text' | 'template'
  template_id:       string | null
  template_name:     string | null     // denormalizado del JOIN con whatsapp_templates
  template_language: string | null
  template_params:   CampaignTemplateParams | null
}

// Payload discriminado para sendViaCloud — separa texto de plantilla
// sin sobrecargar la firma con parámetros opcionales ambiguos.
type CloudSendPayload =
  | { kind: 'text';     body: string; mediaUrl: string | null }
  | { kind: 'template'; content: TemplateContent }

type DispatchUnit = {
  id:           string
  contact_id:   string | null   // null when recipient is a prospect
  prospect_id:  string | null   // null when recipient is a contact
  phone_number: string
  first_name:   string
  attempts:     number
}

export type LineUsageSummary = {
  line_id:      string
  line_key:     string
  display_name: string
  sent:         number
  failed:       number
}

export type DispatchSummary = {
  total:          number
  queued:         number
  processing:     number
  sent:           number
  failed:         number
  skipped:        number
  eligible_lines: number
  line_usage:     LineUsageSummary[]
  top_errors:     { error: string; count: number }[]
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function pickMessage(campaign: CampaignForDispatch): string {
  const pool = Array.isArray(campaign.messages) && campaign.messages.length > 0
    ? campaign.messages
    : [campaign.message]
  return pool[Math.floor(Math.random() * pool.length)]
}

function personalize(raw: string, firstName: string, campaign: CampaignForDispatch): string {
  const nameValue = campaign.personalize_name !== false ? (firstName || '') : ''
  return raw
    .replace(/\{\{nombre\}\}/gi, nameValue)
    .replace(/\{\{name\}\}/gi,   nameValue)
}

// antiblockDelay reemplazada por humanLikeDelay — ver anti-ban-delays.ts

// ── Template helpers ───────────────────────────────────────────────────────────

// Resuelve placeholders de contacto en los valores de template_params.
// Soportados: {{first_name}}, {{phone_number}}.
// Cualquier otro placeholder se deja intacto — Meta los recibirá literalmente.
function resolveTemplateVar(value: string, unit: DispatchUnit): string {
  return value
    .replace(/\{\{first_name\}\}/gi,    unit.first_name   || '')
    .replace(/\{\{phone_number\}\}/gi,  unit.phone_number || '')
}

/**
 * Construye el TemplateContent para la Graph API a partir de los datos de la
 * campaña y el destinatario. No hace ninguna llamada a DB — todo viene en
 * CampaignForDispatch (template_name, template_language, template_params) que
 * se cargó con JOIN en el inicio del dispatch.
 *
 * Lanza si template_name está vacío — el caller debe validar antes.
 */
function buildTemplatePayload(
  campaign: CampaignForDispatch,
  unit:     DispatchUnit,
): TemplateContent {
  const name     = campaign.template_name!
  const language = campaign.template_language ?? 'es'
  const params   = campaign.template_params ?? {}

  const components: TemplateContent['components'] = []

  if (params.header) {
    const mediaType = params.header.type
    const headerParam: TemplateParameter =
      mediaType === 'image'  ? { type: 'image',    image:    { link: params.header.link } } :
      mediaType === 'video'  ? { type: 'video',    video:    { link: params.header.link } } :
                               { type: 'document', document: { link: params.header.link } }
    components.push({ type: 'header', parameters: [headerParam] })
  }

  if (params.body && params.body.length > 0) {
    components.push({
      type:       'body',
      parameters: params.body.map(v => ({ type: 'text' as const, text: resolveTemplateVar(v, unit) })),
    })
  }

  if (params.buttons && params.buttons.length > 0) {
    for (const btn of params.buttons) {
      components.push({
        type:       'button',
        sub_type:   btn.sub_type,
        index:      String(btn.index),
        parameters: [{ type: 'payload', payload: btn.payload }],
      })
    }
  }

  return { name, language: { code: language }, components }
}

// ── isNetworkError ─────────────────────────────────────────────────────────────

/**
 * Clasifica si un error de envío es de RED (atribuible al proxy) o de
 * la capa de aplicación (WhatsApp / Evolution).
 *
 * Solo los errores de red deben incrementar el contador de fallos del proxy.
 * Errores como "número inválido" o "cuenta baneada" no son culpa del proxy.
 */
function isNetworkError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    msg.includes('econnrefused')  ||  // proxy rechazó la conexión
    msg.includes('econnreset')    ||  // conexión cortada abruptamente
    msg.includes('etimedout')     ||  // timeout de TCP (código de error de Node.js)
    msg.includes('enotfound')     ||  // DNS no resolvió el host del proxy
    msg.includes('ehostunreach')  ||  // host inalcanzable (proxy caído)
    msg === 'fetch failed'        ||  // undici: fallo de transporte exacto
    msg.includes('socket hang up')    // node http: conexión cortada por el proxy
    // ELIMINADOS: 'network', 'timeout', 'socket' — demasiado genéricos,
    // capturaban errores de WhatsApp ("Session timeout", "network error") y
    // disparaban rotación de proxy por causas no atribuibles a la red.
  )
}

// ── getEligibleLines ───────────────────────────────────────────────────────────

/**
 * Returns all lines eligible for campaign sending, ordered by best-first:
 * 1. Highest remaining daily capacity (spreads load, avoids exhausting a single line)
 * 2. Lowest priority number (1 = highest priority)
 * 3. Oldest last_seen_at (tie-break for equal capacity + priority)
 *
 * Eligibility requirements:
 *   - status = 'active'
 *   - is_connected = true
 *   - sending_enabled = true (admin kill switch)
 *   - msgs_sent_hour < msg_per_hour (hourly rate limit)
 *   - msgs_sent_today < msg_per_day (daily rate limit)
 *   - allowed_types IS NULL (accepts all) OR includes 'campaign'
 *
 * NOTE: Counter reset is handled externally by reset_line_counters_if_due()
 * (called from WF-013). This function reads current counter values only.
 */
export async function getEligibleLines(operatorId?: string | null): Promise<EligibleLine[]> {
  const { clause, params } = distributorVisibilityClause(operatorId, 1, 'wl')
  // Table alias 'wl' is required to avoid column ambiguity with the cloud_numbers JOIN.
  // Visibility clause uses wl.id so it doesn't collide with cn.id.
  return query<EligibleLine>(`
    SELECT
      wl.id,
      wl.line_type,
      cn.phone_number_id,
      wl.evolution_instance,
      wl.evolution_url,
      wl.msgs_sent_hour,  wl.msgs_sent_today,
      wl.msg_per_hour,    wl.msg_per_day,
      wl.priority,        wl.last_seen_at,
      (wl.msg_per_hour  - wl.msgs_sent_hour)  AS remaining_hour,
      (wl.msg_per_day   - wl.msgs_sent_today) AS remaining_day,
      (wl.personality_config IS NOT NULL)      AS has_personality
    FROM whatsapp_lines wl
    LEFT JOIN cloud_numbers cn
      ON cn.whatsapp_line_id = wl.id AND cn.status = 'active'
    WHERE (${lineEligibleExpr('wl')} OR (${cloudEligibleExpr('wl')} AND cn.id IS NOT NULL))
      ${clause}
    ORDER BY
      (wl.msg_per_day - wl.msgs_sent_today) DESC,
      wl.priority ASC,
      wl.last_seen_at ASC NULLS LAST
  `, params)
}

// ── selectLine ─────────────────────────────────────────────────────────────────

/**
 * Selecciona una línea usando muestreo ponderado por remaining_day.
 *
 * Por qué no simplemente "la primera":
 *   getEligibleLines() ordena por remaining_day DESC. Elegir siempre la primera
 *   concentra todos los envíos en una sola línea hasta agotarla, luego en la
 *   siguiente, etc. Desde el punto de vista de WhatsApp, ese patrón es imposible
 *   para un humano con múltiples números.
 *
 * Muestreo ponderado:
 *   - Líneas con más remaining_day tienen mayor probabilidad de ser elegidas.
 *   - Pero no el 100% — todas las líneas activas participan en cada mensaje.
 *   - Mínimo de peso 1 para que líneas con remaining_day=0 (edge case de refresh
 *     tardío) no tengan peso cero y queden excluidas silenciosamente.
 */
export function selectLine(lines: EligibleLine[]): EligibleLine | null {
  if (lines.length === 0) return null
  if (lines.length === 1) return lines[0]

  const totalWeight = lines.reduce((sum, l) => sum + Math.max(1, l.remaining_day), 0)
  let pick = Math.random() * totalWeight
  for (const line of lines) {
    pick -= Math.max(1, line.remaining_day)
    if (pick <= 0) return line
  }
  return lines[lines.length - 1]  // fallback numérico por precisión de float
}

// ── createDispatchUnits ────────────────────────────────────────────────────────

/**
 * Idempotently seeds campaign_recipients from the campaign's contact list.
 * Safe to call multiple times — ON CONFLICT DO NOTHING prevents duplicates.
 *
 * Applies the same eligibility filters as the existing /send route:
 *   - opt_in_marketing = true
 *   - do_not_contact   = false
 *   - status           = 'active'
 */
export async function createDispatchUnits(
  campaignId: string,
  listId: string,
): Promise<{ total: number; queued: number }> {
  await query(
    `INSERT INTO campaign_recipients (campaign_id, contact_id, phone_number)
     SELECT $1, c.id, c.phone_number
     FROM contacts c
     JOIN contact_list_members clm ON clm.contact_id = c.id
     WHERE clm.list_id        = $2
       AND c.opt_in_marketing = true
       AND c.do_not_contact   = false
       AND c.status           = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM blacklist bl
         WHERE bl.phone_number_normalized = regexp_replace(c.phone_number, '[^0-9]', '', 'g')
           AND bl.removed_at IS NULL
       )
     ON CONFLICT (campaign_id, contact_id) WHERE contact_id IS NOT NULL DO NOTHING`,
    [campaignId, listId]
  )

  const [row] = await query<{ total: string; queued: string }>(
    `SELECT
       COUNT(*)::text                                    AS total,
       COUNT(*) FILTER (WHERE status = 'pending')::text AS queued
     FROM campaign_recipients
     WHERE campaign_id = $1`,
    [campaignId]
  )

  return {
    total:  Number(row?.total  || 0),
    queued: Number(row?.queued || 0),
  }
}

// ── getDispatchSummary ─────────────────────────────────────────────────────────

export async function getDispatchSummary(campaignId: string, operatorId?: string | null): Promise<DispatchSummary> {
  const [counts] = await query<{
    total: string; queued: string; processing: string
    sent: string;  failed: string; skipped: string
  }>(
    `SELECT
       COUNT(*)::text                                             AS total,
       COUNT(*) FILTER (WHERE status = 'pending')::text          AS queued,
       COUNT(*) FILTER (WHERE status = 'sending')::text          AS processing,
       COUNT(*) FILTER (WHERE status = 'sent')::text             AS sent,
       COUNT(*) FILTER (WHERE status = 'failed')::text           AS failed,
       COUNT(*) FILTER (WHERE status = 'skipped')::text          AS skipped
     FROM campaign_recipients
     WHERE campaign_id = $1`,
    [campaignId]
  )

  const eligibleLines = await getEligibleLines(operatorId)

  const lineUsage = await query<LineUsageSummary>(
    `SELECT
       l.id           AS line_id,
       l.line_key,
       l.display_name,
       COUNT(cr.id) FILTER (WHERE cr.status = 'sent')::int   AS sent,
       COUNT(cr.id) FILTER (WHERE cr.status = 'failed')::int AS failed
     FROM whatsapp_lines l
     JOIN campaign_recipients cr
       ON cr.line_id = l.id AND cr.campaign_id = $1
     GROUP BY l.id, l.line_key, l.display_name
     ORDER BY sent DESC`,
    [campaignId]
  )

  const topErrors = await query<{ error: string; count: number }>(
    `SELECT COALESCE(error_detail, 'sin detalle') AS error, COUNT(*)::int AS count
     FROM campaign_recipients
     WHERE campaign_id = $1 AND status = 'failed'
     GROUP BY error_detail
     ORDER BY count DESC
     LIMIT 5`,
    [campaignId]
  ).catch(() => [] as { error: string; count: number }[])

  return {
    total:          Number(counts?.total      || 0),
    queued:         Number(counts?.queued     || 0),
    processing:     Number(counts?.processing || 0),
    sent:           Number(counts?.sent       || 0),
    failed:         Number(counts?.failed     || 0),
    skipped:        Number(counts?.skipped    || 0),
    eligible_lines: eligibleLines.length,
    line_usage:     lineUsage,
    top_errors:     topErrors,
  }
}

// ── sendViaEvolution ───────────────────────────────────────────────────────────

/**
 * Calls the Evolution API directly using the selected line's URL and instance.
 * Returns the provider message ID (or null if the response doesn't include one).
 *
 * Throws on HTTP error or network failure — callers must handle this.
 */
export async function sendViaEvolution(
  line: EligibleLine,
  phone: string,
  message: string,
  mediaUrl?: string | null,
): Promise<{ messageId: string | null }> {
  // Prefer EVOLUTION_GLOBAL_API_KEY (shared admin key) over per-instance key.
  // QR routes use this same fallback pattern — keep them in sync.
  // Use || (not ??) so an empty-string env var is treated as unset.
  const apiKey = process.env.EVOLUTION_GLOBAL_API_KEY || process.env.EVOLUTION_API_KEY
  if (!apiKey) throw new Error('EVOLUTION_API_KEY (or EVOLUTION_GLOBAL_API_KEY) not configured')

  // evolution_url may be NULL in old DB rows — fall back to env var
  const evoUrl = line.evolution_url || process.env.EVOLUTION_URL || ''
  if (!evoUrl) throw new Error(`evolution_url not configured for line ${line.id}`)

  // Evolution v2 rejects numbers with a leading '+' → strip it
  const formattedPhone = phone.startsWith('+') ? phone.slice(1) : phone

  let body: Record<string, unknown>
  if (mediaUrl) {
    body = {
      number: formattedPhone,
      mediaMessage: {
        mediatype: 'image',
        media:     mediaUrl,
        caption:   message,
      },
    }
  } else {
    body = { number: formattedPhone, text: message }
  }

  const url = `${evoUrl}/message/sendText/${line.evolution_instance}`
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', apikey: apiKey },
    body:    JSON.stringify(body),
  })

  if (!res.ok) {
    let errText: string
    try {
      const d = await res.json()
      errText = (d?.message as string) || (d?.error as string) || String(res.status)
    } catch {
      errText = String(res.status)
    }
    throw new Error(`Evolution ${res.status}: ${errText}`)
  }

  let messageId: string | null = null
  try {
    const data = await res.json()
    messageId = (data?.key?.id as string) || (data?.id as string) || null
  } catch { /* empty response body — treat as success with no ID */ }

  return { messageId }
}

// ── sendViaCloud ───────────────────────────────────────────────────────────────

/**
 * Sends a campaign message via WhatsApp Cloud API (Graph API).
 *
 * Accepts a discriminated CloudSendPayload:
 *   - kind='text'     → texto libre o imagen (requiere ventana de 24h abierta)
 *   - kind='template' → plantilla pre-aprobada por Meta (no requiere ventana)
 *
 * Reuses token management (getTokenForNumber) and HTTP layer (MessageSenderService)
 * without going through SendMessageUseCase — the use-case's window check does
 * not apply to campaigns, and its DB persistence conflicts with our pre-insert fence.
 *
 * Rate limiting (20 msg/s) is enforced via enforceRateLimit().
 * Pacing between messages is handled by the distributor's humanLikeDelay.
 */
export async function sendViaCloud(
  line:      EligibleLine,
  phone:     string,
  payload:   CloudSendPayload,
  campaignId?: string,
): Promise<{ messageId: string | null }> {
  const phoneNumberId = line.phone_number_id
  if (!phoneNumberId) throw new Error(`No phone_number_id for cloud line ${line.id}`)

  await enforceRateLimit(phoneNumberId)

  const accessToken = await getTokenForNumber(phoneNumberId)
  const sender      = new MessageSenderService(accessToken, phoneNumberId)

  // Cloud API expects E.164 format (with leading +)
  const to = phone.startsWith('+') ? phone : `+${phone}`

  let req: SendMessageRequest
  if (payload.kind === 'template') {
    req = { phoneNumberId, to, type: 'template', template: payload.content, campaignId }
  } else if (payload.mediaUrl) {
    req = { phoneNumberId, to, type: 'image', image: { link: payload.mediaUrl, caption: payload.body }, campaignId }
  } else {
    req = { phoneNumberId, to, type: 'text', text: { body: payload.body }, campaignId }
  }

  const { wamid } = await sender.send(req)
  return { messageId: wamid || null }
}

// ── Stale recovery ─────────────────────────────────────────────────────────────

/**
 * Recover recipients stuck in 'sending' longer than STALE_SENDING_MINUTES.
 *
 * Three cases (same logic as the existing single-line processor):
 *   - whatsapp_messages confirms success → mark 'sent'
 *   - whatsapp_messages is 'queued' (in-flight) → mark 'failed' (do NOT re-send)
 *   - no message row → reset to 'pending' (safe to retry)
 */
export async function recoverStaleUnits(campaignId: string): Promise<void> {
  try {
    // Confirmed success
    await query(
      `UPDATE campaign_recipients cr
       SET    status = 'sent', locked_at = NULL, updated_at = NOW()
       FROM   whatsapp_messages wm
       WHERE  cr.campaign_id = $1
         AND  cr.status      = 'sending'
         AND  cr.locked_at   < NOW() - INTERVAL '${STALE_SENDING_MINUTES} minutes'
         AND  wm.campaign_recipient_id = cr.id
         AND  wm.status IN ('sent', 'delivered', 'read')`,
      [campaignId]
    )
    // Queued in-flight — do NOT re-send; mark failed to preserve idempotency
    await query(
      `UPDATE campaign_recipients cr
       SET    status = 'failed', locked_at = NULL, updated_at = NOW(),
              error_detail = 'stale-queued-no-resend'
       FROM   whatsapp_messages wm
       WHERE  cr.campaign_id = $1
         AND  cr.status      = 'sending'
         AND  cr.locked_at   < NOW() - INTERVAL '${STALE_SENDING_MINUTES} minutes'
         AND  wm.campaign_recipient_id = cr.id
         AND  wm.status = 'queued'`,
      [campaignId]
    )
    // No message row → reset for retry
    await query(
      `UPDATE campaign_recipients
       SET    status = 'pending', locked_at = NULL, updated_at = NOW()
       WHERE  campaign_id = $1
         AND  status      = 'sending'
         AND  locked_at   < NOW() - INTERVAL '${STALE_SENDING_MINUTES} minutes'`,
      [campaignId]
    )
  } catch (e) {
    clog.error({
      event: 'stale.recovery.error', campaignId, mode: 'multi-line',
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

// ── Atomic claim ───────────────────────────────────────────────────────────────

/**
 * Atomically claim one pending recipient and assign it to the given line.
 *
 * Uses a data-modifying CTE with FOR UPDATE SKIP LOCKED — only one concurrent
 * processor can claim a given row. Returns null if no pending rows remain.
 *
 * Ordering: created_at ASC, id ASC — deterministic, matches existing processor.
 */
async function claimNextUnit(
  campaignId: string,
  lineId: string,
): Promise<DispatchUnit | null> {
  const rows = await query<DispatchUnit>(
    `WITH claimed AS (
       UPDATE campaign_recipients
       SET    status     = 'sending',
              line_id    = $2,
              locked_at  = NOW(),
              attempts   = attempts + 1,
              updated_at = NOW()
       WHERE  id = (
         SELECT id
         FROM   campaign_recipients
         WHERE  campaign_id = $1
           AND  status      = 'pending'
         ORDER BY created_at ASC, id ASC
         LIMIT  1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, contact_id, prospect_id, phone_number, attempts
     )
     SELECT cl.id,
            cl.contact_id,
            cl.prospect_id,
            cl.phone_number,
            cl.attempts,
            COALESCE(c.first_name, p.first_name, '') AS first_name
     FROM   claimed cl
     LEFT JOIN contacts  c ON c.id = cl.contact_id
     LEFT JOIN prospects p ON p.id = cl.prospect_id`,
    [campaignId, lineId]
  )
  return rows[0] ?? null
}

// ── handleSuccess ──────────────────────────────────────────────────────────────

async function handleSuccess(
  campaignId: string,
  unit: DispatchUnit,
  line: EligibleLine,
  messageId: string | null,
  messageBody: string,
  messageKind: 'text' | 'template' = 'text',
  templateName?: string,
): Promise<void> {
  // Queries 1 + 2: críticas, independientes entre sí → paralelo
  await Promise.all([
    query(
      `UPDATE whatsapp_messages
       SET status               = 'sent',
           evolution_message_id = $1,
           sent_at              = NOW(),
           updated_at           = NOW()
       WHERE campaign_recipient_id = $2
         AND status = 'queued'`,
      [messageId, unit.id]
    ),
    query(
      `UPDATE campaign_recipients
       SET status               = 'sent',
           sent_at              = NOW(),
           locked_at            = NULL,
           message_body         = $1,
           evolution_message_id = $2,
           updated_at           = NOW()
       WHERE id = $3`,
      [messageBody, messageId, unit.id]
    ),
  ])

  // Fallback: ensure a 'sent' row exists if the pre-insert never ran (e.g. index missing, DB error)
  await query(
    `INSERT INTO whatsapp_messages
       (contact_id, campaign_id, phone_number, message_body, direction, status,
        evolution_message_id, sent_at, campaign_recipient_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'outbound', 'sent', $5, NOW(), $6, NOW(), NOW())
     ON CONFLICT (campaign_recipient_id)
       WHERE campaign_recipient_id IS NOT NULL
     DO UPDATE SET
       status               = CASE WHEN whatsapp_messages.status IN ('delivered','read') THEN whatsapp_messages.status ELSE 'sent' END,
       evolution_message_id = COALESCE(whatsapp_messages.evolution_message_id, EXCLUDED.evolution_message_id),
       updated_at           = NOW()`,
    [unit.contact_id, campaignId, unit.phone_number, messageBody, messageId, unit.id]
  ).catch(e =>
    clog.warn({
      event: 'sent.fallback.insert.error', campaignId, mode: 'multi-line',
      recipientId: unit.id, error: e instanceof Error ? e.message : String(e),
    })
  )

  // Queries 3 + 4: no críticas, independientes entre sí → paralelo, swallow errors
  await Promise.all([
    query(`SELECT increment_line_counters($1)`, [line.id]).catch(e =>
      clog.error({
        event: 'increment.counters.error', campaignId, mode: 'multi-line',
        lineId: line.id, error: e instanceof Error ? e.message : String(e),
      })
    ),
    query(
      `INSERT INTO line_usage_log (line_id, campaign_id, recipient_id, status)
       VALUES ($1, $2, $3, 'sent')`,
      [line.id, campaignId, unit.id]
    ).catch(() => {}),
  ])

  clog.info({
    event:       'recipient.sent',
    campaignId,
    mode:        'multi-line',
    recipientId: unit.id,
    contactId:   unit.contact_id,
    lineId:      line.id,
    provider:    line.line_type,
    messageKind,
    ...(templateName ? { templateName } : {}),
  })
}

// ── handleFailure ──────────────────────────────────────────────────────────────

async function handleFailure(
  campaignId: string,
  unit: DispatchUnit,
  line: EligibleLine,
  errDetail: string,
  maxRetries = MAX_RETRIES,
  messageKind: 'text' | 'template' = 'text',
  templateName?: string,
): Promise<void> {
  // Update queued → failed in whatsapp_messages (only if still queued)
  await query(
    `UPDATE whatsapp_messages
     SET status       = 'failed',
         failed_at    = NOW(),
         error_detail = $1,
         updated_at   = NOW()
     WHERE campaign_recipient_id = $2
       AND status = 'queued'`,
    [errDetail, unit.id]
  ).catch(() => {})

  // Ensure a failed message row exists even if the provider rejected before pre-insert ran
  await query(
    `INSERT INTO whatsapp_messages
       (contact_id, campaign_id, phone_number, message_body, direction, status,
        failed_at, error_detail, campaign_recipient_id, created_at, updated_at)
     VALUES ($1, $2, $3, '', 'outbound', 'failed', NOW(), $4, $5, NOW(), NOW())
     ON CONFLICT (campaign_recipient_id)
       WHERE campaign_recipient_id IS NOT NULL
     DO NOTHING`,
    [unit.contact_id, campaignId, unit.phone_number, errDetail, unit.id]
  ).catch(() => {})

  if (unit.attempts < maxRetries) {
    // Reset for retry — clear line_id so a fresh line is selected next attempt
    await query(
      `UPDATE campaign_recipients
       SET status       = 'pending',
           locked_at    = NULL,
           line_id      = NULL,
           error_detail = $1,
           failed_at    = NOW(),
           updated_at   = NOW()
       WHERE id = $2`,
      [errDetail, unit.id]
    )
  } else {
    // Permanent failure — max retries exhausted
    await query(
      `UPDATE campaign_recipients
       SET status       = 'failed',
           failed_at    = NOW(),
           locked_at    = NULL,
           error_detail = $1,
           updated_at   = NOW()
       WHERE id = $2`,
      [errDetail, unit.id]
    )
  }

  // Write usage log (non-critical)
  // Line counters are NOT incremented on failure — the message was never delivered.
  await query(
    `INSERT INTO line_usage_log (line_id, campaign_id, recipient_id, status, error_message)
     VALUES ($1, $2, $3, 'failed', $4)`,
    [line.id, campaignId, unit.id, errDetail]
  ).catch(() => {})

  clog.warn({
    event:       'recipient.failed',
    campaignId,
    mode:        'multi-line',
    recipientId: unit.id,
    contactId:   unit.contact_id,
    lineId:      line.id,
    attempt:     unit.attempts,
    provider:    line.line_type,
    error:       errDetail,
    permanent:   unit.attempts >= maxRetries,
    messageKind,
    ...(templateName ? { templateName } : {}),
  })
}

// ── syncCounters ───────────────────────────────────────────────────────────────

async function syncCounters(
  campaignId: string,
): Promise<{ sent: number; failed: number; skipped: number; pending: number }> {
  // SELECT is critical — let it throw on DB failure so the outer try/finally
  // in processMultiLineInBackground releases the processor lock cleanly.
  // Swallowing the error here would return pending:0 and cause the loop to
  // break early, potentially marking the campaign 'completed' prematurely.
  const [row] = await query<{ sent: string; failed: string; skipped: string; pending: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'sent')                AS sent,
       COUNT(*) FILTER (WHERE status = 'failed')              AS failed,
       COUNT(*) FILTER (WHERE status = 'skipped')             AS skipped,
       COUNT(*) FILTER (WHERE status IN ('pending','sending')) AS pending
     FROM campaign_recipients
     WHERE campaign_id = $1`,
    [campaignId]
  )
  const sent    = Number(row?.sent    || 0)
  const failed  = Number(row?.failed  || 0)
  const skipped = Number(row?.skipped || 0)
  const pending = Number(row?.pending || 0)
  // UPDATE is non-critical (counters are derived, not authoritative) — swallow
  // failures so a transient write error doesn't abort the entire send loop.
  await query(
    `UPDATE campaigns SET total_sent = $1, total_failed = $2, total_skipped = $3 WHERE id = $4`,
    [sent, failed, skipped, campaignId]
  ).catch(e =>
    clog.error({
      event: 'sync.counters.write.error', campaignId, mode: 'multi-line',
      error: e instanceof Error ? e.message : String(e),
    })
  )
  return { sent, failed, skipped, pending }
}

// ── sendOneUnit ────────────────────────────────────────────────────────────────

/**
 * Reclama y envía una unidad pendiente para una línea específica.
 *
 * Encapsula: claim atómico → pre-insert → send (Evolution o Cloud) → handleSuccess/Failure.
 * Diseñado para ser llamado en paralelo desde Promise.allSettled sobre
 * múltiples líneas activas, una unidad por línea por ciclo.
 *
 * Retorna:
 *   'sent'    — mensaje enviado y confirmado en DB
 *   'failed'  — envío fallido (registrado en handleFailure)
 *   'no-unit' — no había unidades pendientes para esta línea
 *   'skipped' — contacto bloqueado por frecuencia o error Cloud no-reintentable
 */
type SendOneUnitOptions = {
  // Called each time the frequency engine throws and the send continues anyway
  // (fail-open). Used by the main loop to accumulate a counter for alerting.
  onFreqFailOpen?: () => void
}

async function sendOneUnit(
  campaignId:  string,
  line:        EligibleLine,
  campaign:    CampaignForDispatch,
  maxRetries:  number,
  opts:        SendOneUnitOptions = {},
): Promise<'sent' | 'failed' | 'no-unit' | 'skipped'> {
  const unit = await claimNextUnit(campaignId, line.id)
  if (!unit) return 'no-unit'

  // ── Frequency gate ──────────────────────────────────────────────────────────
  //
  // Evalúa los límites por contacto (1/día, 2/semana, 48h cooldown) y reserva
  // el slot atómicamente usando pg_advisory_xact_lock — sin race condition TOCTOU.
  //
  // Graceful degradation (fail-open): si el motor falla (timeout de DB, error
  // transitorio), el envío CONTINÚA. La disponibilidad de la campaña tiene prioridad
  // sobre el control de frecuencia estricto ante fallos de infraestructura.
  // Para cambiar a fail-closed, lanzar aquí en lugar de continuar.
  //
  // BLOCK  → el contacto superó sus límites; se marca 'skipped' sin reintentos.
  // DELAY  → riesgo moderado pero dentro de límites; se continúa (slot ya reservado).
  // ALLOW  → sin restricciones activas; flujo normal.
  let freqDecision: 'ALLOW' | 'DELAY' | 'BLOCK' = 'ALLOW'
  let freqReason   = ''
  // Frequency engine only applies to contacts. Prospects don't have frequency rules.
  if (unit.contact_id) {
    try {
      const freqResult = await ContactFrequencyEngine.atomicEvaluateAndRecord(
        {
          contactId:    unit.contact_id,
          operatorId:   campaign.owned_by,
          campaignId,
          segMonto:     null,
          segActividad: null,
        },
        {
          contactId:           unit.contact_id,
          campaignId,
          operatorId:          campaign.owned_by,
          phoneNumber:         unit.phone_number,
          campaignRecipientId: unit.id,
        },
      )
      freqDecision = freqResult.decision
      freqReason   = freqResult.reason
    } catch (freqErr) {
      clog.error({
        event:       'freq.engine.error',
        campaignId,
        mode:        'multi-line',
        recipientId: unit.id,
        contactId:   unit.contact_id,
        error:       freqErr instanceof Error ? freqErr.message : String(freqErr),
      })
      opts.onFreqFailOpen?.()
    }
  }

  if (freqDecision === 'BLOCK') {
    // Límite de frecuencia superado: marcar como 'skipped' sin reintentar.
    // La ventana de frecuencia es rolling (24h/7d), no de calendario.
    await query(
      `UPDATE campaign_recipients
       SET status       = 'skipped',
           error_detail = $1,
           failed_at    = NOW(),
           locked_at    = NULL,
           updated_at   = NOW()
       WHERE id = $2`,
      [`[freq-blocked] ${freqReason}`, unit.id],
    ).catch(e =>
      clog.error({
        event: 'recipient.skipped.write.error', campaignId, mode: 'multi-line',
        recipientId: unit.id, error: e instanceof Error ? e.message : String(e),
      })
    )
    clog.warn({
      event:       'recipient.skipped',
      campaignId,
      mode:        'multi-line',
      recipientId: unit.id,
      contactId:   unit.contact_id,
      reason:      'freq-blocked',
      detail:      freqReason,
    })
    return 'skipped'
  }

  // DELAY: el slot ya fue pre-registrado en contact_send_history dentro de la
  // transacción atómica. Continuamos el envío — el humanLikeDelay del loop
  // principal ya introduce separación temporal entre mensajes del mismo ciclo.

  // Para campañas de texto: mensaje aleatorio del pool, personalizado con el nombre.
  // Para campañas de plantilla: marcador legible; el contenido real lo define Meta.
  const messageBody = campaign.message_type === 'template'
    ? `[template:${campaign.template_name!}]`
    : personalize(pickMessage(campaign), unit.first_name, campaign)

  // lineLabel: identificador legible del provider para todos los logs de este ciclo.
  // Definido antes del pre-insert para que esté disponible en su log de error.
  const lineLabel = line.line_type === 'cloud'
    ? `cloud:${line.phone_number_id}`
    : `evo:${line.evolution_instance}`

  // Pre-insert idempotency fence
  await query(
    `INSERT INTO whatsapp_messages
       (contact_id, campaign_id, phone_number, message_body, direction, status,
        campaign_recipient_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'outbound', 'queued', $5, NOW(), NOW())
     ON CONFLICT (campaign_recipient_id)
       WHERE campaign_recipient_id IS NOT NULL
     DO UPDATE SET
       status       = 'queued',
       message_body = EXCLUDED.message_body,
       updated_at   = NOW()
     WHERE whatsapp_messages.status NOT IN ('sent', 'delivered', 'read')`,
    [unit.contact_id, campaignId, unit.phone_number, messageBody, unit.id]
  ).catch(e =>
    clog.warn({
      event: 'pre.insert.queued.error', campaignId, mode: 'multi-line',
      lineLabel, error: e instanceof Error ? e.message : String(e),
    })
  )

  // Proxy: Evolution-only. Cloud lines call Graph API directly — no proxy involved.
  const proxy = line.line_type === 'evolution'
    ? await getProxyForLine(line.id).catch(() => null)
    : null

  // ── Send-start log ──────────────────────────────────────────────────────────
  if (line.line_type === 'evolution') {
    if (proxy) {
      clog.info({
        event: 'unit.send.start', campaignId, mode: 'multi-line',
        lineLabel, proxy: proxy.label, proxyType: proxy.proxyType, country: proxy.country ?? 'unknown',
      })
    } else {
      clog.warn({
        event: 'unit.send.no_proxy', campaignId, mode: 'multi-line',
        lineLabel, lineId: line.id,
        detail: 'línea sin proxy asignado o unhealthy — enviando directo',
      })
    }
  } else {
    clog.info({ event: 'unit.send.start', campaignId, mode: 'multi-line', lineLabel })
  }

  try {
    const { messageId } = line.line_type === 'cloud'
      ? await sendViaCloud(
          line, unit.phone_number,
          campaign.message_type === 'template'
            ? { kind: 'template', content: buildTemplatePayload(campaign, unit) }
            : { kind: 'text', body: messageBody, mediaUrl: campaign.media_url },
          campaignId,
        )
      : await sendViaEvolution(line, unit.phone_number, messageBody, campaign.media_url)

    await handleSuccess(campaignId, unit, line, messageId, messageBody,
      campaign.message_type, campaign.template_name ?? undefined)
    updateLastActiveAt(line.id)
    return 'sent'
  } catch (err) {
    // Cloud API: contact-level non-retryable errors (see CLOUD_SKIP_CODES).
    // These come from MetaHttpGateway as CloudApiError — not from the use-case layer.
    // Marking as 'skipped' avoids wasting MAX_RETRIES on structurally unsendable recipients.
    if (err instanceof CloudApiError && CLOUD_SKIP_CODES.has(err.code ?? -1)) {
      const reason = err.code === 131047 ? 'cloud-no-window'
                   : err.code === 131026 ? 'cloud-opted-out'
                   : 'cloud-non-retryable'
      await query(
        `UPDATE campaign_recipients
         SET status       = 'skipped',
             error_detail = $1,
             failed_at    = NOW(),
             locked_at    = NULL,
             updated_at   = NOW()
         WHERE id = $2`,
        [`[${reason}] ${err.message}`, unit.id],
      ).catch(() => {})
      clog.warn({
        event:       'recipient.skipped',
        campaignId,
        mode:        'multi-line',
        recipientId: unit.id,
        contactId:   unit.contact_id,
        lineId:      line.id,
        reason,
        errorCode:   err.code,
      })
      return 'skipped'
    }

    const errMsg = err instanceof Error ? err.message : String(err)
    console.error(
      `[distributor ${campaignId}] send failed ***${unit.phone_number.slice(-4)} via ${lineLabel}:`, errMsg
    )
    if (proxy && isNetworkError(err)) {
      await reportProxySendFailure(proxy.id, line.id, errMsg).catch(() => {})
    }
    await handleFailure(campaignId, unit, line, errMsg, maxRetries,
      campaign.message_type, campaign.template_name ?? undefined)
    return 'failed'
  }
}

// ── processMultiLineInBackground ───────────────────────────────────────────────

/**
 * Background processor for multi-line campaign distribution.
 * Follows the same lock/heartbeat/completion pattern as the existing single-line
 * processor (processInBackground in /api/campaigns/[id]/send/route.ts).
 *
 * Key differences:
 *  - Re-evaluates eligible lines on each iteration (respects updated counters)
 *  - Routes per line_type: Evolution (per-instance URL) or Cloud API (Graph API)
 *  - Pauses the campaign automatically if no eligible lines remain
 *  - Clears the unit's line_id on retryable failure (allows line re-selection)
 *
 * No-eligible-lines behaviour:
 *  - Campaign status is set to 'paused'
 *  - All unsent recipients remain 'pending' (not failed)
 *  - Resuming (calling /dispatch/process again) will retry when lines recover
 */
export async function processMultiLineInBackground(
  campaign: CampaignForDispatch,
  lockToken: string,
  maxRetries = MAX_RETRIES,
): Promise<void> {
  const id = campaign.id
  let sendCount = 0

  // AbortController para cancelar delays en curso cuando la campaña se pausa/cancela.
  // Se pasa a humanLikeDelay — permite interrumpir pausas burst de hasta 90 min.
  const delayController = new AbortController()

  try {
    // ── Guard temprano de API key ─────────────────────────────────────────────
    // Solo pausar si falta EVOLUTION_API_KEY Y no hay líneas Cloud disponibles
    // que puedan cubrir la campaña. Un setup cloud-only no necesita la key de Evolution.
    const evolutionApiKey = process.env.EVOLUTION_GLOBAL_API_KEY || process.env.EVOLUTION_API_KEY
    if (!evolutionApiKey) {
      const [{ hasCloud }] = await query<{ hasCloud: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM cloud_numbers cn
           JOIN whatsapp_lines wl ON wl.id = cn.whatsapp_line_id
           WHERE cn.status = 'active' AND wl.status = 'active' AND wl.sending_enabled = true
         ) AS "hasCloud"`,
      ).catch(() => [{ hasCloud: false }])

      if (!hasCloud) {
        clog.critical({
          event: 'config.missing', campaignId: id, mode: 'multi-line',
          detail: 'EVOLUTION_API_KEY not set and no active Cloud lines — pausing campaign',
        })
        await query(
          `UPDATE campaigns
           SET status = 'paused', pause_reason = 'config_missing',
               processor_locked_at = NULL, processor_lock_token = NULL
           WHERE id = $1`,
          [id],
        ).catch(() => {})
        return
      }
      clog.warn({
        event: 'config.evolution_key_missing', campaignId: id, mode: 'multi-line',
        detail: 'EVOLUTION_API_KEY not set — campaign will use Cloud API lines only',
      })
    }

    // Template campaigns require a resolved template_name (denormalized via JOIN in dispatch
    // routes). Fail fast here so the whole campaign pauses immediately rather than producing
    // per-recipient silent fallbacks or errors at scale.
    if (campaign.message_type === 'template' && !campaign.template_name) {
      clog.critical({
        event: 'config.missing', campaignId: id, mode: 'multi-line',
        detail: 'message_type=template pero template_name es null — verificar JOIN en dispatch routes',
      })
      await query(
        `UPDATE campaigns
         SET status = 'paused', pause_reason = 'config_missing',
             processor_locked_at = NULL, processor_lock_token = NULL
         WHERE id = $1`,
        [id],
      ).catch(() => {})
      return
    }

    clog.info({ event: 'processor.start', campaignId: id, mode: 'multi-line' })
    await recoverStaleUnits(id)

    // ── Bug B: Resetear contadores de líneas sin depender de n8n WF-013 ────────
    // reset_line_counters_if_due() reinicia msgs_sent_hour/msgs_sent_today cuando
    // sus respectivos períodos vencieron. Normalmente lo llama n8n WF-013 cada 5 min;
    // llamarlo aquí garantiza que los contadores no bloqueen el envío si n8n no corre.
    try {
      await query(`SELECT reset_line_counters_if_due()`)
    } catch (e) {
      clog.warn({
        event: 'line.counters.reset.error', campaignId: id, mode: 'multi-line',
        error: e instanceof Error ? e.message : String(e),
        detail: 'continuando — contadores pueden estar desactualizados',
      })
    }

    // ── Hydratar personalidades desde DB (evita reset a 'normal' en cada restart) ──
    try {
      const linesToHydrate = await getEligibleLines(campaign.owned_by)
      if (linesToHydrate.length > 0) {
        const personalityRows = await query<{ id: string; personality_config: unknown }>(
          `SELECT id, personality_config FROM whatsapp_lines WHERE id = ANY($1::uuid[])`,
          [linesToHydrate.map(l => l.id)],
        )
        for (const row of personalityRows) {
          hydratePersonalityFromRecord(row.id, row.personality_config)
        }
        clog.info({
          event: 'personality.hydrated', campaignId: id, mode: 'multi-line',
          count: personalityRows.length,
        })

        // Evictar personalidades de líneas que ya no son elegibles.
        // Previene crecimiento indefinido del store en procesos de larga vida.
        const eligibleIds = new Set(linesToHydrate.map(l => l.id))
        let evicted = 0
        for (const lineId of getLoadedLineIds()) {
          if (!eligibleIds.has(lineId)) {
            evictPersonality(lineId)
            evicted++
          }
        }
        if (evicted > 0) {
          clog.info({
            event: 'personality.evicted', campaignId: id, mode: 'multi-line', count: evicted,
          })
        }
      }
    } catch (e) {
      clog.warn({
        event: 'personality.hydration.error', campaignId: id, mode: 'multi-line',
        error: e instanceof Error ? e.message : String(e),
      })
    }

    // Limpiar blacklist temporal de proxies expirados al inicio de cada campaña
    const flushed = flushExpiredBlacklist()
    if (flushed > 0) {
      clog.info({
        event: 'proxy.blacklist.flushed', campaignId: id, mode: 'multi-line', count: flushed,
      })
    }

    // Cache de líneas elegibles: evita una query a whatsapp_lines por cada mensaje.
    // Se refresca cada ELIGIBLE_TTL_MS o cuando el array queda vacío.
    let cachedEligibleLines: EligibleLine[] = []
    let eligibleLinesFetchedAt = 0
    const ELIGIBLE_TTL_MS = 10_000  // 10 segundos

    // Safety counter contra loop infinito (bug D): Si Promise.allSettled devuelve
    // sólo rejected (claimNextUnit lanza por error de DB), allEmpty nunca es true.
    // Tras MAX_CONSECUTIVE_ALL_FAILED ciclos fallidos consecutivos, forzamos pausa.
    let consecutiveAllFailed = 0
    const MAX_CONSECUTIVE_ALL_FAILED = 5

    // Freq fail-open counter: cada vez que el motor de frecuencia lanza una excepción
    // y el envío continúa de todas formas (graceful degradation), lo contamos.
    // Si acumula demasiados en esta sesión, advertimos para detectar problemas sostenidos.
    let freqEngineFailOpenCount = 0
    const FREQ_FAIL_OPEN_WARN_THRESHOLD = 10

    while (true) {
      // ── 1. Status gate ──────────────────────────────────────────────────────
      const [current] = await query<{ status: string }>(
        'SELECT status FROM campaigns WHERE id = $1', [id]
      )
      if (!current || current.status === 'paused' || current.status === 'cancelled' || current.status === 'completed') {
        delayController.abort()  // cancelar cualquier delay en curso
        break
      }

      // ── 2. Refresh eligible lines (con cache TTL) ───────────────────────────
      // Sin cache: 1 query a whatsapp_lines por mensaje enviado.
      // Con TTL 10s: ~1 query cada 10 mensajes en campañas de ritmo normal.
      const nowMs = Date.now()
      if (cachedEligibleLines.length === 0 || nowMs - eligibleLinesFetchedAt > ELIGIBLE_TTL_MS) {
        cachedEligibleLines = await getEligibleLines(campaign.owned_by)
        eligibleLinesFetchedAt = nowMs
      }
      const eligibleLines = cachedEligibleLines
      if (eligibleLines.length === 0) {
        // Diagnóstico: explicar por qué no hay líneas elegibles antes de pausar.
        // Evita tener que revisar la DB manualmente para entender el bloqueo.
        const [lineStats] = await query<{
          total: string; offline: string; disconnected: string
          disabled: string; limit_hour: string; limit_day: string
        }>(
          `SELECT
             COUNT(*)::text                                                                         AS total,
             COUNT(*) FILTER (WHERE status != 'active')::text                                      AS offline,
             COUNT(*) FILTER (WHERE status = 'active' AND NOT is_connected)::text                  AS disconnected,
             COUNT(*) FILTER (WHERE status = 'active' AND is_connected AND NOT sending_enabled)::text AS disabled,
             COUNT(*) FILTER (WHERE status = 'active' AND is_connected AND sending_enabled
                                AND msgs_sent_hour >= msg_per_hour)::text                          AS limit_hour,
             COUNT(*) FILTER (WHERE status = 'active' AND is_connected AND sending_enabled
                                AND msgs_sent_today >= msg_per_day)::text                          AS limit_day
           FROM whatsapp_lines`,
        ).catch(() => [null])

        clog.warn({
          event: 'campaign.paused', campaignId: id, mode: 'multi-line',
          pause_reason: 'no_eligible_lines',
          lines_total:        Number(lineStats?.total        ?? 0),
          lines_offline:      Number(lineStats?.offline      ?? 0),
          lines_disconnected: Number(lineStats?.disconnected ?? 0),
          lines_disabled:     Number(lineStats?.disabled     ?? 0),
          lines_limit_hour:   Number(lineStats?.limit_hour   ?? 0),
          lines_limit_day:    Number(lineStats?.limit_day    ?? 0),
        })
        await query(
          `UPDATE campaigns SET status = 'paused', pause_reason = 'no_eligible_lines'
           WHERE id = $1 AND status = 'running'`,
          [id]
        )
        break
      }

      // ── 2.5. Personality gate — filtrar líneas activas según horario ──────────
      // Cada línea tiene su propia ventana de actividad con jitter ±30-90 min.
      // Solo las líneas dentro de su ventana participan en este ciclo.
      // getLoadedPersonality() es O(1) — todas las personalidades ya están en memoria
      // desde la fase de hidratación del inicio del ciclo (hydratePersonalityFromRecord).
      //
      // Template gate: las campañas de tipo 'template' solo pueden enviarse por
      // Cloud API (Meta requiere plantillas aprobadas para mensajes proactivos).
      // Las líneas Evolution se excluyen para evitar 'skipped' masivos innecesarios.
      const activeLines = eligibleLines.filter(l => {
        if (campaign.message_type === 'template' && l.line_type !== 'cloud') return false
        if (!l.has_personality) return true
        const personality = getLoadedPersonality(l.id)
        return !personality || shouldLineBeActiveNow(personality)
      })

      if (activeLines.length === 0) {
        // Caso distinto de no_eligible_lines: hay líneas con cuota, pero todas
        // fuera de su ventana de personalidad. Se retoman solas cuando entren en horario.
        clog.warn({
          event: 'campaign.paused', campaignId: id, mode: 'multi-line',
          pause_reason: 'all_lines_outside_schedule',
          eligible_count: eligibleLines.length,
        })
        await query(
          `UPDATE campaigns SET status = 'paused', pause_reason = 'all_lines_outside_schedule'
           WHERE id = $1 AND status = 'running'`,
          [id]
        )
        break
      }

      // ── 3-5. Claim + send en paralelo: una unidad por línea activa ──────────
      // claimNextUnit usa FOR UPDATE SKIP LOCKED — seguro para concurrencia.
      // Cada línea puede reclamar y enviar su propia unidad simultáneamente.
      // Throughput = N mensajes por ciclo (N = activeLines.length).
      const results = await Promise.allSettled(
        activeLines.map(line => sendOneUnit(id, line, campaign, maxRetries, {
          onFreqFailOpen: () => {
            freqEngineFailOpenCount++
            if (freqEngineFailOpenCount >= FREQ_FAIL_OPEN_WARN_THRESHOLD) {
              clog.warn({
                event: 'freq.engine.failopen.accumulated', campaignId: id, mode: 'multi-line',
                count: freqEngineFailOpenCount,
                detail: 'motor de frecuencia con errores repetidos — enviando sin control de frecuencia',
              })
            }
          },
        }))
      )

      const sentThisCycle    = results.filter(r => r.status === 'fulfilled' && r.value === 'sent').length
      const skippedThisCycle = results.filter(r => r.status === 'fulfilled' && r.value === 'skipped').length
      sendCount += sentThisCycle
      if (skippedThisCycle > 0) {
        clog.info({
          event: 'cycle.freq_blocked', campaignId: id, mode: 'multi-line',
          skipped: skippedThisCycle,
        })
      }

      // Si todas las líneas no encontraron unidades → no hay más pendientes.
      // 'skipped' no cuenta como 'no-unit': hubo unidades pero fueron bloqueadas
      // por frecuencia; pueden existir más unidades pendientes no bloqueadas.
      const allEmpty = results.every(
        r => r.status === 'fulfilled' && r.value === 'no-unit'
      )
      if (allEmpty) break

      // Detectar ciclos donde TODAS las promises fueron rechazadas (error de DB en
      // claimNextUnit). allEmpty nunca sería true en ese caso, causando loop infinito.
      const allRejected = results.length > 0 && results.every(r => r.status === 'rejected')
      if (allRejected) {
        consecutiveAllFailed++
        const rejectedErr = (results[0] as PromiseRejectedResult).reason
        clog.warn({
          event: 'cycle.all_rejected', campaignId: id, mode: 'multi-line',
          consecutive: consecutiveAllFailed, max: MAX_CONSECUTIVE_ALL_FAILED,
          error: rejectedErr instanceof Error ? rejectedErr.message : String(rejectedErr),
        })
        if (consecutiveAllFailed >= MAX_CONSECUTIVE_ALL_FAILED) {
          clog.critical({
            event: 'campaign.paused', campaignId: id, mode: 'multi-line',
            pause_reason: 'systemic_error',
            consecutive_failures: consecutiveAllFailed,
            detail: 'todos los ciclos rechazados — pausando campaña',
          })
          await query(
            `UPDATE campaigns SET status = 'paused', pause_reason = 'systemic_error'
             WHERE id = $1 AND status = 'running'`, [id]
          ).catch(() => {})
          break
        }
      } else {
        consecutiveAllFailed = 0
      }

      // ── 6. (vacío — syncCounters movido al heartbeat) ───────────────────────

      // ── 7. Pacing delay — personalidad de la línea de mayor capacidad ───────
      // Un delay por ciclo (no por línea) — el batch completo ya se envió.
      // Se usa la personalidad de la primera línea activa (mayor capacidad residual).
      const leadLine        = activeLines[0]
      const leadPersonality = getLoadedPersonality(leadLine.id) ?? await getLinePersonality(leadLine.id)
      const adjustedDelay   = getAdjustedDelayConfig(buildDelayConfig(campaign), leadPersonality)
      await humanLikeDelay(adjustedDelay, delayController.signal)

      // ── 8. Heartbeat: lock + personality persist + counters ─────────────────
      if (sendCount > 0 && sendCount % LOCK_HEARTBEAT_EVERY === 0) {
        await query(
          `UPDATE campaigns SET processor_locked_at = NOW()
           WHERE id = $1 AND processor_lock_token = $2`,
          [id, lockToken]
        ).catch(e => clog.error({
          event: 'heartbeat.lock.error', campaignId: id, mode: 'multi-line',
          error: e instanceof Error ? e.message : String(e),
        }))

        // Persistir personalidad de todas las líneas activas del ciclo.
        // savePersonalityToDB() escribe directamente en whatsapp_lines.personality_config.
        await Promise.allSettled(
          activeLines.map(async line => {
            const personality = getLoadedPersonality(line.id)
            if (!personality) return
            await savePersonalityToDB(personality)
          })
        )

        // Sync counters de progreso (movido desde hot path)
        await syncCounters(id).catch(e =>
          clog.error({
            event: 'heartbeat.sync_counters.error', campaignId: id, mode: 'multi-line',
            error: e instanceof Error ? e.message : String(e),
          })
        )
      }
    }

    // Resolve any recipients stuck in 'sending' from this processor run.
    // Promise.allSettled already resolved all promises, so there are no
    // legitimately in-flight units. 'sending' rows at this point are artifacts
    // of handleSuccess/handleFailure DB errors — if left unresolved they make
    // syncCounters return pending>0 and the campaign never reaches 'completed'.
    await query(
      `UPDATE campaign_recipients cr
       SET    status = 'sent', locked_at = NULL, updated_at = NOW()
       FROM   whatsapp_messages wm
       WHERE  cr.campaign_id = $1
         AND  cr.status      = 'sending'
         AND  wm.campaign_recipient_id = cr.id
         AND  wm.status IN ('sent', 'delivered', 'read')`,
      [id],
    ).catch(() => {})
    await query(
      `UPDATE campaign_recipients cr
       SET    status = 'failed', locked_at = NULL, updated_at = NOW(),
              error_detail = 'stale-queued-no-resend'
       FROM   whatsapp_messages wm
       WHERE  cr.campaign_id = $1
         AND  cr.status      = 'sending'
         AND  wm.campaign_recipient_id = cr.id
         AND  wm.status = 'queued'`,
      [id],
    ).catch(() => {})
    await query(
      `UPDATE campaign_recipients
       SET    status = 'failed', locked_at = NULL, updated_at = NOW(),
              error_detail = 'send-lost-processor-exit'
       WHERE  campaign_id = $1
         AND  status      = 'sending'`,
      [id],
    ).catch(() => {})

    // Final counter sync + mark completed if all work is done
    const { sent, failed, skipped, pending } = await syncCounters(id)
    const [finalState] = await query<{ status: string }>(
      'SELECT status FROM campaigns WHERE id = $1', [id]
    )
    if (finalState?.status === 'running' && pending === 0) {
      await query(
        `UPDATE campaigns SET status = 'completed', completed_at = NOW() WHERE id = $1`,
        [id]
      )
      clog.info({
        event: 'campaign.completed', campaignId: id, mode: 'multi-line',
        sent, failed, skipped,
      })
    } else {
      clog.info({
        event: 'processor.end', campaignId: id, mode: 'multi-line',
        sent, failed, skipped, pending,
        finalStatus: finalState?.status ?? 'unknown',
      })
    }

  } catch (err) {
    // AbortError: el delay fue cancelado porque la campaña se pausó/canceló.
    // No es un error fatal — el loop ya salió limpiamente. Dejar que el finally libere el lock.
    if (err instanceof DOMException && err.name === 'AbortError') {
      console.log(`[distributor ${id}] delay cancelado por abort — procesador detenido limpiamente`)
      return
    }
    throw err
  } finally {
    // Asegurar que el signal esté abortado para liberar cualquier listener pendiente
    delayController.abort()

    // Always release the lock — only if still owned by this processor (token match)
    await query(
      `UPDATE campaigns
       SET processor_locked_at = NULL, processor_lock_token = NULL
       WHERE id = $1 AND processor_lock_token = $2`,
      [id, lockToken]
    ).catch(() => {})
  }
}

// ── getContactEligibilityBreakdown ─────────────────────────────────────────────

export type ContactEligibilityBreakdown = {
  total_in_list:  number
  eligible:       number
  opted_out:      number
  do_not_contact: number
  inactive:       number
  blacklisted:    number
}

/**
 * Explains WHY a contact list produces 0 eligible recipients.
 * Run only when the seed INSERT returns 0 rows — not in the hot send path.
 */
export async function getContactEligibilityBreakdown(
  listId: string,
): Promise<ContactEligibilityBreakdown> {
  const [row] = await query<{
    total_in_list: string; eligible: string; opted_out: string
    do_not_contact: string; inactive: string; blacklisted: string
  }>(`
    SELECT
      COUNT(DISTINCT c.id)::text AS total_in_list,
      COUNT(DISTINCT c.id) FILTER (
        WHERE c.opt_in_marketing = true
          AND c.do_not_contact   = false
          AND c.status           = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM blacklist bl
            WHERE bl.phone_number_normalized = regexp_replace(c.phone_number,'[^0-9]','','g')
              AND bl.removed_at IS NULL
          )
      )::text AS eligible,
      COUNT(DISTINCT c.id) FILTER (WHERE c.opt_in_marketing = false)::text AS opted_out,
      COUNT(DISTINCT c.id) FILTER (WHERE c.do_not_contact   = true)::text  AS do_not_contact,
      COUNT(DISTINCT c.id) FILTER (
        WHERE c.status != 'active'
          AND c.opt_in_marketing = true
          AND c.do_not_contact   = false
      )::text AS inactive,
      COUNT(DISTINCT c.id) FILTER (
        WHERE c.opt_in_marketing = true
          AND c.do_not_contact   = false
          AND c.status           = 'active'
          AND EXISTS (
            SELECT 1 FROM blacklist bl
            WHERE bl.phone_number_normalized = regexp_replace(c.phone_number,'[^0-9]','','g')
              AND bl.removed_at IS NULL
          )
      )::text AS blacklisted
    FROM contacts c
    JOIN contact_list_members clm ON clm.contact_id = c.id
    WHERE clm.list_id = $1
  `, [listId]).catch(() => [null])

  return {
    total_in_list:  Number(row?.total_in_list  ?? 0),
    eligible:       Number(row?.eligible       ?? 0),
    opted_out:      Number(row?.opted_out      ?? 0),
    do_not_contact: Number(row?.do_not_contact ?? 0),
    inactive:       Number(row?.inactive       ?? 0),
    blacklisted:    Number(row?.blacklisted    ?? 0),
  }
}

/**
 * Builds a human-readable, actionable error message from a breakdown.
 */
export function formatEligibilityError(b: ContactEligibilityBreakdown): string {
  if (b.total_in_list === 0) return 'La lista no tiene contactos.'
  const parts: string[] = []
  if (b.opted_out      > 0) parts.push(`${b.opted_out} sin opt-in de marketing`)
  if (b.do_not_contact > 0) parts.push(`${b.do_not_contact} con do_not_contact`)
  if (b.inactive       > 0) parts.push(`${b.inactive} inactivos`)
  if (b.blacklisted    > 0) parts.push(`${b.blacklisted} en blacklist`)
  const detail = parts.length > 0 ? ` Excluidos: ${parts.join(', ')}.` : ''
  return `No hay contactos elegibles (${b.total_in_list} en lista).${detail}`
}

// ── acquireProcessorLock ───────────────────────────────────────────────────────

/**
 * Atomically transition campaign status to 'running' and acquire processor lock.
 * Identical pattern to the existing /send route.
 *
 * Returns the lock token string on success, or null if the lock is already held
 * by a non-stale processor.
 */
export async function acquireProcessorLock(
  campaignId: string,
  currentStatus: string,
): Promise<string | null> {
  const newToken = crypto.randomUUID()
  const rows = await query<{ id: string }>(
    `UPDATE campaigns
     SET status = CASE
           WHEN status IN ('draft','scheduled','paused') THEN 'running'
           ELSE status
         END,
         started_at = CASE
           WHEN status IN ('draft','scheduled','paused')
             THEN COALESCE(started_at, NOW())
           ELSE started_at
         END,
         pause_reason         = NULL,
         processor_locked_at  = NOW(),
         processor_lock_token = $2,
         total_targets = (
           SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = $1
         )
     WHERE id = $1
       AND status IN ('draft','scheduled','paused','running')
       AND (processor_locked_at IS NULL
            OR processor_locked_at < NOW() - INTERVAL '${PROCESSOR_LOCK_MINUTES} minutes')
     RETURNING id`,
    [campaignId, newToken]
  )
  return rows[0] ? newToken : null
}
