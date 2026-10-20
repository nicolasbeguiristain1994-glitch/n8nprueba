import { query } from '@/lib/db'
import { CampaignRiskError, raiseRiskIncident, clearMetaRiskSignal, assertCloudSendRiskClear } from '@/lib/campaign-risk'
import { distributorVisibilityClause } from '@/lib/line-visibility'
import { MetaHttpGateway } from './infrastructure/meta-http.gateway'
import type { PhoneNumberInfo } from './infrastructure/phone-number.service'
import { getTokenForNumber } from './token-store'
import { applyPhoneQualityRisk, applyPhoneHealthRisk, type MetaHealthStatus, handleTemplateQualityRisk, handleTemplateStatusRisk } from './webhook-handlers/meta-risk.handler'

const CACHE_MS = 60_000
const inFlight = new Map<string, Promise<unknown>>()
const phoneQualities = new Set(['GREEN', 'YELLOW', 'RED', 'UNKNOWN', 'NA'])
const operationalChecks = new Map<string, { checkedAt: number; templateId: string; wabaId: string }>()
type PhoneRow = { phone_number_id: string; waba_id: string; risk_checked_at: Date | string | null }
type TemplateRow = { id: string; name: string; language: string; waba_id: string; whatsapp_template_id: string; risk_checked_at: Date | string | null }

function fresh(date: Date | string | null): boolean {
  if (!date) return false
  const age = Date.now() - new Date(date).getTime()
  return age >= 0 && age < CACHE_MS
}

function once<T>(key: string, work: () => Promise<T>): Promise<T> {
  const current = inFlight.get(key)
  if (current) return current as Promise<T>
  const pending = work().finally(() => { inFlight.delete(key) })
  inFlight.set(key, pending)
  return pending
}

export async function refreshPhoneMetaRisk(phoneNumberId: string): Promise<PhoneNumberInfo> {
  return once(`phone:${phoneNumberId}`, async () => {
    if (!/^\d+$/.test(phoneNumberId)) throw new Error('Identificador de línea inválido')
    const [number] = await query<{ waba_id: string }>(`SELECT waba_id FROM cloud_numbers WHERE phone_number_id=$1`, [phoneNumberId])
    if (!number) throw new Error('Línea de Meta desconocida')
    const token = await getTokenForNumber(phoneNumberId)
    const gateway = new MetaHttpGateway(token, { timeoutMs: 8_000 })
    // A recovery observation cannot supersede a webhook newer than this request.
    const observedAt = new Date().toISOString()
    const info = await gateway.get<PhoneNumberInfo & { health_status?: MetaHealthStatus }>(`/${phoneNumberId}?fields=id,quality_rating,verified_name,platform_type,throughput,health_status`)
    if (String(info.id) !== phoneNumberId || !phoneQualities.has(info.quality_rating) || !Array.isArray(info.health_status?.entities)) {
      throw new Error('Meta no devolvió una calidad válida para la línea')
    }
    // Persist the hold before marking the observation fresh. A DB failure must
    // never let the cache turn an unprocessed warning into permission to send.
    await applyPhoneHealthRisk(phoneNumberId, number.waba_id, info.health_status, observedAt)
    await applyPhoneQualityRisk(phoneNumberId, info.quality_rating, observedAt)
    await query(`UPDATE cloud_numbers SET quality_rating=$1, verified_name=COALESCE($2,verified_name),
      risk_checked_at=$3, updated_at=NOW() WHERE phone_number_id=$4
        AND (risk_checked_at IS NULL OR risk_checked_at<=$3::timestamptz)`,
    [info.quality_rating, info.verified_name ?? null, observedAt, phoneNumberId])
    return info
  })
}

async function refreshTemplate(row: TemplateRow, phoneNumberId: string): Promise<void> {
  return once(`template:${row.id}`, async () => {
    if (!/^\d+$/.test(row.whatsapp_template_id)) throw new Error('Identificador de plantilla inválido')
    const token = await getTokenForNumber(phoneNumberId)
    const gateway = new MetaHttpGateway(token, { timeoutMs: 8_000 })
    const observedAt = new Date().toISOString()
    const template = await gateway.get<{ id: string; name: string; language: string; status: string; quality_score?: { score: string } }>(
      `/${row.whatsapp_template_id}?fields=id,name,language,status,quality_score`,
    )
    const quality = template.quality_score?.score ?? (template.status === 'PENDING' ? 'UNKNOWN' : undefined)
    if (String(template.id) !== row.whatsapp_template_id || template.name !== row.name || template.language !== row.language
      || typeof template.status !== 'string' || !quality
      || !['GREEN', 'YELLOW', 'RED', 'UNKNOWN'].includes(quality)) {
      throw new Error('Meta no devolvió un estado y calidad válidos para la plantilla')
    }
    const identity = { message_template_id: row.whatsapp_template_id, message_template_name: row.name, message_template_language: row.language }
    await handleTemplateStatusRisk({ ...identity, event: template.status }, row.waba_id, observedAt)
    await handleTemplateQualityRisk({ ...identity, new_quality_score: quality }, row.waba_id, observedAt)
    const status = template.status === 'APPROVED' ? 'APROBADA'
      : template.status === 'REJECTED' ? 'RECHAZADA'
      : ['DISABLED', 'PAUSED', 'ARCHIVED', 'DELETED', 'PENDING_DELETION'].includes(template.status) ? 'DESHABILITADA' : 'EN_REVISION'
    await query(`UPDATE whatsapp_templates SET status=$1, risk_checked_at=$2, updated_at=NOW()
      WHERE id=$3 AND waba_id=$4 AND whatsapp_template_id=$5
        AND (risk_checked_at IS NULL OR risk_checked_at<=$2::timestamptz)`, [status, observedAt, row.id, row.waba_id, row.whatsapp_template_id])
  })
}

type OperationalTemplate = {
  id: string; name: string; language: string; category: string; status: string
  quality_score?: { score?: string }
  components?: Array<{ type: string; format?: string; text?: string; buttons?: Array<{ type: string; text?: string; url?: string }> }>
}

function fixedOperationalComponents(components: OperationalTemplate['components']): boolean {
  if (!Array.isArray(components) || components.filter(c => c.type === 'BODY').length !== 1) return false
  if (JSON.stringify(components).includes('{{') || JSON.stringify(components).includes('}}')) return false
  const seen = new Set<string>()
  for (const component of components) {
    if (seen.has(component.type)) return false
    seen.add(component.type)
    if (['BODY', 'FOOTER'].includes(component.type)) {
      if (typeof component.text !== 'string' || !component.text.trim()) return false
    } else if (component.type === 'HEADER') {
      if (component.format !== 'TEXT' || typeof component.text !== 'string' || !component.text.trim()) return false
    } else if (component.type === 'BUTTONS') {
      if (!Array.isArray(component.buttons) || !component.buttons.length) return false
      for (const button of component.buttons) {
        if (button.type !== 'URL' || typeof button.text !== 'string' || !button.text.trim() || typeof button.url !== 'string') return false
        try {
          const url = new URL(button.url)
          if (url.protocol !== 'https:' || url.username || url.password) return false
        } catch { return false }
      }
    } else return false
  }
  return true
}

/** Preflight for the explicitly configured operational alert sender, never a campaign fallback. */
export async function refreshOperationalAlertMeta(
  phoneNumberId: string, templateName: string, language: string, templateId?: string,
): Promise<{ templateId: string; wabaId: string }> {
  if (!/^\d+$/.test(phoneNumberId) || !/^[a-z0-9_]+$/.test(templateName)
    || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language) || (templateId !== undefined && !/^\d+$/.test(templateId))) {
    throw new CampaignRiskError('La configuración de la alerta de WhatsApp es inválida.')
  }
  // Recheck local availability on every send, including a cached remote check.
  const [sender] = await query<{ waba_id: string }>(`SELECT cn.waba_id FROM cloud_numbers cn
    JOIN whatsapp_lines wl ON wl.id=cn.whatsapp_line_id
    WHERE cn.phone_number_id=$1 AND cn.status='active' AND wl.line_type='cloud'
      AND wl.status='active' AND wl.sending_enabled=true AND wl.is_connected=true`, [phoneNumberId])
  if (!sender || !/^\d+$/.test(sender.waba_id)) {
    throw new CampaignRiskError('La línea configurada para alertas no está disponible.')
  }
  const key = JSON.stringify([phoneNumberId, sender.waba_id, templateName, language, templateId ?? null])
  const result = await once(`operational:${key}`, async () => {
    const cached = operationalChecks.get(key)
    if (cached && Date.now() >= cached.checkedAt && Date.now() - cached.checkedAt < CACHE_MS) return cached
    operationalChecks.delete(key)
    const checkedAt = Date.now()
    const info = await refreshPhoneMetaRisk(phoneNumberId) as PhoneNumberInfo & { health_status: MetaHealthStatus }
    if (['YELLOW', 'RED'].includes(info.quality_rating) || info.health_status.can_send_message === 'BLOCKED'
      || info.health_status.entities.some(entity => entity.can_send_message === 'BLOCKED')) {
      throw new CampaignRiskError('Meta informa una restricción o calidad insuficiente en la línea de alertas.')
    }
    const token = await getTokenForNumber(phoneNumberId)
    const gateway = new MetaHttpGateway(token, { timeoutMs: 8_000 })
    // Read through this WABA's collection even when an explicit remote ID is
    // configured: fetching a template by ID alone does not prove ownership.
    const params = new URLSearchParams({ name: templateName, fields: 'id,name,language,category,status,quality_score,components', limit: '100' })
    const list = await gateway.get<{ data?: OperationalTemplate[]; paging?: { next?: string } }>(`/${sender.waba_id}/message_templates?${params}`)
    if (!Array.isArray(list.data) || list.paging?.next) throw new Error('Meta no devolvió una lista completa de plantillas de alerta')
    const matches = list.data.filter(template => template.name === templateName && template.language === language)
    if (matches.length !== 1 || !/^\d+$/.test(String(matches[0].id))
      || (templateId !== undefined && String(matches[0].id) !== templateId)) {
      throw new CampaignRiskError('La plantilla de alerta no pertenece a la cuenta o no coincide con la configuración.')
    }
    const template = matches[0]
    const quality = template.quality_score?.score
    const observedAt = new Date(checkedAt).toISOString()
    const identity = { message_template_id: String(template.id), message_template_name: templateName, message_template_language: language }
    await handleTemplateStatusRisk({ ...identity, event: template.status }, sender.waba_id, observedAt)
    if (quality && ['GREEN', 'YELLOW', 'RED', 'UNKNOWN'].includes(quality)) {
      await handleTemplateQualityRisk({ ...identity, new_quality_score: quality }, sender.waba_id, observedAt)
    }
    if (template.category !== 'UTILITY' || template.status !== 'APPROVED' || !quality || !['GREEN', 'UNKNOWN'].includes(quality)
      || !fixedOperationalComponents(template.components)) {
      throw new CampaignRiskError('La alerta requiere una plantilla UTILITY aprobada, de calidad válida y sin parámetros.')
    }
    const verified = { checkedAt, templateId: String(template.id), wabaId: sender.waba_id }
    // Do not cache before persistence and the active-signal guard succeed.
    await assertCloudSendRiskClear({ phoneNumberId, templateName })
    for (const [existingKey, check] of operationalChecks) {
      if (Date.now() - check.checkedAt >= CACHE_MS) operationalChecks.delete(existingKey)
    }
    operationalChecks.set(key, verified)
    return verified
  })
  // A webhook received after the cached GET must still prevent the next send.
  await assertCloudSendRiskClear({ phoneNumberId, templateName })
  return { templateId: result.templateId, wabaId: result.wabaId }
}

async function runBounded<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const failures: unknown[] = []
  await Promise.all(Array.from({ length: Math.min(2, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]
      try { await work(item) } catch (error) { failures.push(error) }
    }
  }))
  if (failures.length) throw new Error(`No se pudo verificar la calidad de ${failures.length} recursos de Meta`)
}

export async function refreshCampaignMetaRisk(campaignId: string): Promise<void> {
  try {
    const [campaign] = await query<{ message_type: string; template_id: string | null; owned_by: string | null; use_multi_line: boolean }>(
      `SELECT message_type, template_id, owned_by, use_multi_line FROM campaigns WHERE id=$1`, [campaignId],
    )
    if (!campaign) throw new Error('Campaña no encontrada')
    // The legacy single-sender processor uses Evolution, not Cloud API.
    if (campaign.message_type !== 'template' && !campaign.use_multi_line) return
    const templates = campaign.message_type === 'template'
      ? await query<TemplateRow>(`SELECT id, name, language, waba_id, whatsapp_template_id, risk_checked_at
          FROM whatsapp_templates WHERE id=$1`, [campaign.template_id]) : []
    const template = templates[0]
    if (campaign.message_type === 'template' && (!template?.waba_id || !template.whatsapp_template_id)) {
      throw new Error('Falta la asociación de la plantilla con Meta')
    }
    // A campaign may select any available sender in its WABA. Check the whole
    // candidate pool, including senders not assigned to a recipient yet.
    const visibility = distributorVisibilityClause(campaign.owned_by, 2, 'wl')
    const numbers = await query<PhoneRow>(`SELECT cn.phone_number_id,cn.waba_id,cn.risk_checked_at
      FROM cloud_numbers cn JOIN whatsapp_lines wl ON wl.id=cn.whatsapp_line_id
      WHERE cn.status='active' AND wl.sending_enabled=true AND wl.line_type='cloud'
        AND wl.status='active' AND wl.is_connected=true
        AND (wl.allowed_types IS NULL OR wl.allowed_types @> '["campaign"]'::jsonb)
        AND ($1::text IS NULL OR cn.waba_id=$1) ${visibility.clause}`, [template?.waba_id ?? null, ...visibility.params])
    if (template && !numbers.length) throw new Error('No hay una línea activa para verificar la plantilla')
    await runBounded(numbers.filter(n => !fresh(n.risk_checked_at)), async n => { await refreshPhoneMetaRisk(n.phone_number_id) })
    if (template && !fresh(template.risk_checked_at)) await refreshTemplate(template, numbers[0].phone_number_id)
    await clearMetaRiskSignal({ scopeType: 'campaign', scopeId: campaignId, signals: ['meta_check_unavailable'], observedAt: new Date().toISOString() })
  } catch {
    await raiseRiskIncident({ scopeType: 'campaign', scopeId: campaignId, source: 'panel', signal: 'meta_check_unavailable',
      title: 'No se pudo verificar la calidad de Meta',
      detail: 'Pausa preventiva: el control de calidad no pudo completarse. Revisá la conexión con Meta y volvé a verificar antes de reanudar.',
    })
    throw new CampaignRiskError('No se pudo verificar la calidad de Meta. La campaña permanece detenida.')
  }
}

export async function refreshAllMetaRisk(): Promise<void> {
  const numbers = await query<PhoneRow>(`SELECT phone_number_id,waba_id,risk_checked_at FROM cloud_numbers WHERE status='active'`)
  const templates = await query<TemplateRow>(`SELECT id,name,language,waba_id,whatsapp_template_id,risk_checked_at
    FROM whatsapp_templates WHERE waba_id IS NOT NULL AND whatsapp_template_id IS NOT NULL
      AND status IN ('APROBADA','DESHABILITADA','EN_REVISION')`)
  const checks: Array<() => Promise<void>> = numbers.map(n => async () => {
    if (!fresh(n.risk_checked_at)) await refreshPhoneMetaRisk(n.phone_number_id)
  })
  for (const template of templates) {
    const sender = numbers.find(n => n.waba_id === template.waba_id)
    if (sender && !fresh(template.risk_checked_at)) checks.push(() => refreshTemplate(template, sender.phone_number_id))
  }
  await runBounded(checks, work => work())
}

type RiskRefreshGlobal = typeof globalThis & { __metaRiskRefreshTimer?: ReturnType<typeof setInterval>; __metaRiskRefreshBusy?: boolean }

export function startMetaRiskRefresh(): void {
  const runtime = globalThis as RiskRefreshGlobal
  if (runtime.__metaRiskRefreshTimer) return
  const tick = async () => {
    if (runtime.__metaRiskRefreshBusy) return
    runtime.__metaRiskRefreshBusy = true
    try { await refreshAllMetaRisk() }
    catch { console.warn('[campaign-risk] No se pudo completar la verificación periódica de Meta; los envíos requieren su control previo.') }
    finally { runtime.__metaRiskRefreshBusy = false }
  }
  runtime.__metaRiskRefreshTimer = setInterval(() => { void tick() }, 180_000)
  runtime.__metaRiskRefreshTimer.unref?.()
  void tick()
}
