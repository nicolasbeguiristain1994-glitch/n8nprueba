import type { PoolClient } from 'pg'
import { enqueueCampaignRiskWhatsAppAlerts } from '@/lib/campaign-risk-alerts'
import { query, withTransaction } from '@/lib/db'

type Scope = 'campaign' | 'waba' | 'phone' | 'template'
export type CampaignRiskIncident = {
  id: string; source: 'meta' | 'panel'; scopeType: Scope; scopeId: string; signal: string
  title: string; detail: string; detectedAt: string; metrics: Record<string, unknown>; signalActive: boolean
}
export type CampaignRiskState = { blocked: boolean; incidents: CampaignRiskIncident[] }
export class CampaignRiskError extends Error {
  readonly status = 409
  readonly code = 'CAMPAIGN_RISK_BLOCKED'
  constructor(message = 'Campaña detenida por una alerta de riesgo. Revisá el motivo antes de reanudar.') {
    super(message); this.name = 'CampaignRiskError'
  }
}
type RiskInput = { scopeType: Scope; scopeId: string; source: 'meta' | 'panel'; signal: string;
  title: string; detail: string; metrics?: Record<string, unknown>; observedAt?: string }
type DB = Pick<PoolClient, 'query'>
const candidateScope = `EXISTS(SELECT 1 FROM cloud_numbers cn JOIN whatsapp_lines wl ON wl.id=cn.whatsapp_line_id
 WHERE ((s.scope_type='phone' AND cn.phone_number_id=s.scope_id) OR (s.scope_type='waba' AND cn.waba_id=s.scope_id))
   AND (c.message_type='template' OR c.use_multi_line=true)
   AND cn.status='active' AND wl.line_type='cloud' AND wl.status='active' AND wl.is_connected AND wl.sending_enabled
   AND (wl.allowed_types IS NULL OR wl.allowed_types @> '["campaign"]'::jsonb)
   AND (c.owned_by IS NULL OR wl.id IN (SELECT id FROM get_accessible_line_ids(c.owned_by) AS visible_lines(id)))
   AND (c.message_type IS DISTINCT FROM 'template' OR EXISTS(SELECT 1 FROM whatsapp_templates wt
     WHERE wt.id=c.template_id AND wt.waba_id=cn.waba_id)))`
// Aliases c (campaign) and s (signal) are fixed internal identifiers, never user input.
const matchesCampaign = `(
 (s.scope_type='campaign' AND s.scope_id=c.id::text)
 OR (s.scope_type='template' AND EXISTS(SELECT 1 FROM whatsapp_templates wt
   WHERE wt.id=c.template_id AND s.scope_id=wt.waba_id||':'||wt.name))
 OR (s.scope_type='waba' AND (EXISTS(SELECT 1 FROM whatsapp_templates wt
   WHERE wt.id=c.template_id AND s.scope_id=wt.waba_id)
   OR EXISTS(SELECT 1 FROM campaign_recipients r JOIN cloud_numbers cn ON cn.whatsapp_line_id=r.line_id
     WHERE r.campaign_id=c.id AND cn.waba_id=s.scope_id) OR ${candidateScope}))
 OR (s.scope_type='phone' AND (EXISTS(SELECT 1 FROM campaign_recipients r JOIN cloud_numbers cn ON cn.whatsapp_line_id=r.line_id
   WHERE r.campaign_id=c.id AND cn.phone_number_id=s.scope_id)
   OR ${candidateScope}))
)`
export const CAMPAIGN_RISK_CLEAR_SQL = `(c.pause_reason IS DISTINCT FROM 'risk_detected'
 AND NOT EXISTS(SELECT 1 FROM campaign_risk_incidents ri WHERE ri.campaign_id=c.id AND ri.resolved_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM campaign_risk_signals s WHERE s.signal_active AND ${matchesCampaign}))`

async function riskLock(db: DB) {
  // Serializes signal/review changes across processes; no network calls in this transaction.
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('campaign-risk-state',0))")
}
async function attachSignals(db: DB, campaignIds?: string[]) {
  const selected = await db.query<{ id: string }>(`SELECT c.id FROM campaigns c
    WHERE ($1::uuid[] IS NULL AND c.status IN ('draft','scheduled','running','paused') OR c.id=ANY($1::uuid[]))
      AND (EXISTS(SELECT 1 FROM campaign_risk_signals s WHERE s.signal_active AND ${matchesCampaign}
        AND (c.status IN ('draft','scheduled','running','paused') OR s.scope_type='campaign'))
        OR c.pause_reason='risk_detected') ORDER BY c.id FOR UPDATE`, [campaignIds ?? null])
  if (!selected.rows.length) return
  const ids = selected.rows.map(r => r.id)
  await db.query(`INSERT INTO campaign_risk_incidents(campaign_id,scope_type,scope_id,signal,source,title,detail,metrics,last_observed_at)
    SELECT c.id,s.scope_type,s.scope_id,s.signal,s.source,s.title,s.detail,s.metrics,s.observed_at
    FROM campaigns c JOIN campaign_risk_signals s ON s.signal_active AND ${matchesCampaign} WHERE c.id=ANY($1::uuid[])
    ON CONFLICT(campaign_id,scope_type,scope_id,signal) WHERE resolved_at IS NULL DO UPDATE
      SET title=EXCLUDED.title,detail=EXCLUDED.detail,metrics=EXCLUDED.metrics,last_observed_at=EXCLUDED.last_observed_at`, [ids])
  // Recover a fail-closed pause recorded while the incident store was unavailable.
  await db.query(`INSERT INTO campaign_risk_incidents(campaign_id,scope_type,scope_id,signal,source,title,detail)
    SELECT c.id,'campaign',c.id::text,'risk_record_unavailable','panel','Control de seguridad pendiente',
      'Se detuvo el envío, pero no se pudo guardar el detalle original. Revisá los registros y la conexión antes de reanudar.'
    FROM campaigns c WHERE c.id=ANY($1::uuid[]) AND c.pause_reason='risk_detected'
      AND NOT EXISTS(SELECT 1 FROM campaign_risk_incidents i WHERE i.campaign_id=c.id AND i.resolved_at IS NULL)
    ON CONFLICT DO NOTHING`, [ids])
  await db.query(`UPDATE campaigns SET status='paused',pause_reason='risk_detected',updated_at=NOW()
    WHERE id=ANY($1::uuid[]) AND status IN ('running','scheduled','paused')`, [ids])
  await db.query(`INSERT INTO notifications(user_id,type,title,body,link,related_type,related_id,metadata)
    SELECT u.id,'alerta_operativa','Campaña detenida: '||c.name,i.title||'. '||i.detail,
      '/campaigns?campaign='||c.id,'campaign',c.id::text,
      jsonb_build_object('risk_incident_id',i.id,'risk_signal',i.signal,'source',i.source)
    FROM campaign_risk_incidents i JOIN campaigns c ON c.id=i.campaign_id
    JOIN users u ON u.is_active AND (u.role='admin' OR u.id=c.owned_by)
    WHERE c.id=ANY($1::uuid[]) AND i.resolved_at IS NULL ON CONFLICT DO NOTHING`, [ids])
  await enqueueCampaignRiskWhatsAppAlerts(db,ids)
}

export async function raiseRiskIncident(input: RiskInput): Promise<void> {
  await withTransaction(async db => {
    await riskLock(db)
    await db.query(`INSERT INTO campaign_risk_signals(scope_type,scope_id,signal,source,signal_active,observed_at,title,detail,metrics)
      VALUES($1,$2,$3,$4,true,COALESCE($5::timestamptz,clock_timestamp()),$6,$7,$8::jsonb)
      ON CONFLICT(scope_type,scope_id,signal) DO UPDATE SET signal_active=true,observed_at=EXCLUDED.observed_at,
        source=EXCLUDED.source,title=EXCLUDED.title,detail=EXCLUDED.detail,metrics=EXCLUDED.metrics
      WHERE campaign_risk_signals.observed_at < EXCLUDED.observed_at`,
    [input.scopeType,input.scopeId,input.signal,input.source,input.observedAt ?? null,input.title,input.detail,JSON.stringify(input.metrics ?? {})])
    await attachSignals(db, input.scopeType === 'campaign' ? [input.scopeId] : undefined)
  })
}

export async function clearMetaRiskSignal(input: { scopeType: Scope; scopeId: string; signals?: string[]; observedAt?: string }): Promise<void> {
  if (!input.signals?.length) throw new Error('La recuperación debe identificar las señales verificadas')
  await withTransaction(async db => {
    await riskLock(db)
    // Keep recovery tombstones: an older delayed webhook cannot reopen a recovered signal.
    for (const signal of input.signals!) await db.query(`INSERT INTO campaign_risk_signals
      (scope_type,scope_id,signal,source,signal_active,observed_at,title,detail)
      VALUES($1,$2,$3,'meta',false,COALESCE($4::timestamptz,clock_timestamp()),'Señal recuperada','')
      ON CONFLICT(scope_type,scope_id,signal) DO UPDATE SET signal_active=false,observed_at=EXCLUDED.observed_at
      WHERE campaign_risk_signals.observed_at <= EXCLUDED.observed_at`, [input.scopeType,input.scopeId,signal,input.observedAt ?? null])
  })
}

export async function getCampaignRiskStates(campaignIds: string[]): Promise<Record<string, CampaignRiskState>> {
  const ids = [...new Set(campaignIds)]
  if (!ids.length) return {}
  // Also materializes holds for newly created campaigns or a recovered safety-store outage.
  await withTransaction(async db => { await riskLock(db); await attachSignals(db, ids) })
  const rows = await query<CampaignRiskIncident & { campaignId: string }>(`SELECT i.id,i.campaign_id AS "campaignId",i.source,
    i.scope_type AS "scopeType",i.scope_id AS "scopeId",i.signal,i.title,i.detail,i.detected_at AS "detectedAt",i.metrics,
    COALESCE(s.signal_active,false) AS "signalActive" FROM campaign_risk_incidents i
    LEFT JOIN campaign_risk_signals s ON (s.scope_type,s.scope_id,s.signal)=(i.scope_type,i.scope_id,i.signal)
    WHERE i.campaign_id=ANY($1::uuid[]) AND i.resolved_at IS NULL ORDER BY i.detected_at,i.id`, [ids])
  const states: Record<string, CampaignRiskState> = Object.fromEntries(ids.map(id => [id,{blocked:false,incidents:[]}]))
  for (const { campaignId, ...incident } of rows) {
    states[campaignId].blocked = true
    states[campaignId].incidents.push({ ...incident, detectedAt: new Date(incident.detectedAt).toISOString() })
  }
  return states
}
export async function getCampaignRiskState(campaignId: string): Promise<CampaignRiskState> {
  return (await getCampaignRiskStates([campaignId]))[campaignId]
}
export async function assertCampaignRiskClear(campaignId: string): Promise<void> {
  try { if ((await getCampaignRiskState(campaignId)).blocked) throw new CampaignRiskError() }
  catch (error) { if (error instanceof CampaignRiskError) throw error
    throw new CampaignRiskError('No se pudo comprobar la protección de la campaña. El envío permanece detenido.') }
}
export async function assertCloudSendRiskClear(input: { campaignId?: string; phoneNumberId: string; templateName?: string }, db?: DB): Promise<void> {
  const sql = `SELECT 1 FROM campaign_risk_signals s WHERE s.signal_active
    AND ($3::uuid IS NOT NULL OR $2::text IS NOT NULL OR s.signal IN
      ('meta_account_restriction','meta_account_disabled','meta_account_violation','meta_account_connection','meta_account_health','meta_phone_health')) AND (
      s.scope_type='phone' AND s.scope_id=$1
      OR s.scope_type='waba' AND EXISTS(SELECT 1 FROM cloud_numbers cn WHERE cn.phone_number_id=$1 AND cn.waba_id=s.scope_id)
      OR s.scope_type='template' AND EXISTS(SELECT 1 FROM cloud_numbers cn WHERE cn.phone_number_id=$1 AND s.scope_id=cn.waba_id||':'||$2)
      OR s.scope_type='campaign' AND s.scope_id=$3::text)
    UNION ALL SELECT 1 FROM campaigns c WHERE c.id=$3::uuid AND NOT ${CAMPAIGN_RISK_CLEAR_SQL} LIMIT 1`
  try {
    const params = [input.phoneNumberId,input.templateName ?? null,input.campaignId ?? null]
    const rows = db ? (await db.query(sql,params)).rows : await query(sql,params)
    if (rows.length) throw new CampaignRiskError()
  } catch (error) { if (error instanceof CampaignRiskError) throw error
    throw new CampaignRiskError('No se pudo comprobar el estado de seguridad de Meta. El envío permanece detenido.') }
}

export async function reviewCampaignRisk(input: { campaignId: string; userId: string; note: string; incidentIds: string[] }): Promise<void> {
  if (input.note.trim().length < 10) throw new CampaignRiskError('Describí la revisión con al menos 10 caracteres.')
  await withTransaction(async db => {
    await riskLock(db)
    const authorized = await db.query(`SELECT c.id FROM campaigns c JOIN users u ON u.id=$2 AND u.is_active
      WHERE c.id=$1 AND (u.role='admin' OR (u.role='operator' AND c.owned_by=u.id
        AND u.sectors @> '["campaigns","send"]'::jsonb)) FOR UPDATE OF c FOR SHARE OF u`, [input.campaignId,input.userId])
    if (!authorized.rows.length) throw new CampaignRiskError('No tenés acceso para revisar esta campaña.')
    await attachSignals(db,[input.campaignId])
    const current = await db.query<{ id: string; active: boolean }>(`SELECT i.id,(i.source='meta' AND COALESCE(s.signal_active,false)
        OR i.signal='meta_check_unavailable' AND COALESCE(s.signal_active,false)) AS active
      FROM campaign_risk_incidents i LEFT JOIN campaign_risk_signals s
        ON (s.scope_type,s.scope_id,s.signal)=(i.scope_type,i.scope_id,i.signal)
      WHERE i.campaign_id=$1 AND i.resolved_at IS NULL`, [input.campaignId])
    const expected = [...new Set(input.incidentIds)].sort()
    if (!current.rows.length || JSON.stringify(current.rows.map(r=>r.id).sort()) !== JSON.stringify(expected))
      throw new CampaignRiskError('Las alertas cambiaron. Actualizá y revisá todas las señales actuales.')
    if (current.rows.some(r=>r.active)) throw new CampaignRiskError('La señal de Meta sigue activa o su estado no pudo verificarse.')
    await db.query(`UPDATE campaign_risk_incidents SET resolved_at=clock_timestamp(),reviewed_by=$2,review_note=$3
      WHERE campaign_id=$1 AND resolved_at IS NULL`, [input.campaignId,input.userId,input.note.trim().slice(0,2000)])
    await db.query(`UPDATE campaign_risk_signals SET signal_active=false,observed_at=clock_timestamp()
      WHERE scope_type='campaign' AND scope_id=$1 AND source='panel'`, [input.campaignId])
    await db.query(`UPDATE campaigns SET status=CASE WHEN status IN ('running','scheduled') THEN 'paused' ELSE status END,
      pause_reason=CASE WHEN pause_reason='risk_detected' THEN 'manual' ELSE pause_reason END,updated_at=NOW() WHERE id=$1`, [input.campaignId])
  })
}

// Preventive product defaults, not Meta enforcement thresholds or a probability of a ban.
export const CAMPAIGN_RISK_THRESHOLDS = { minimumDelivered: 50, minimumOptOuts: 5, optOutRate: 0.05,
  minimumAttempts: 50, minimumEcosystemErrors: 10, ecosystemErrorRate: 0.20 } as const
export async function evaluateCampaignRisk(campaignId: string): Promise<void> {
  const [stats] = await query<{ delivered: number; optouts: number; attempts: number; ecosystem: number }>(`
    WITH cutoff AS (SELECT GREATEST(NOW()-interval '24 hours',COALESCE(MAX(resolved_at),'-infinity'::timestamptz)) AS at
      FROM campaign_risk_incidents WHERE campaign_id=$1),
    attempts AS (
      SELECT COALESCE(w.evolution_message_id,'legacy:'||w.id) AS key,
        regexp_replace(w.phone_number,'[^0-9]','','g') AS phone,w.status::text AS status,
        CASE WHEN w.error_detail LIKE '%[meta:131049]%' THEN 131049 END AS code
      FROM whatsapp_messages w,cutoff WHERE w.campaign_id=$1 AND w.direction='outbound'
        AND w.created_at>=cutoff.at AND w.status::text IN ('sent','delivered','read','failed')
      UNION ALL
      SELECT COALESCE(m.wamid,'cloud:'||m.id),regexp_replace(cv.contact_phone,'[^0-9]','','g'),m.status,m.error_code
      FROM cloud_messages m JOIN cloud_conversations cv ON cv.id=m.conversation_id,cutoff
      WHERE m.campaign_id=$1 AND m.direction='outbound' AND m.created_at>=cutoff.at AND m.status IN ('sent','delivered','read','failed')
    ), dedup AS (SELECT key,MAX(phone) AS phone,bool_or(status IN ('delivered','read')) AS delivered,
      bool_or(status='failed' AND code=131049) AS ecosystem FROM attempts GROUP BY key),
    delivered AS (SELECT DISTINCT phone FROM dedup WHERE delivered),
    optouts AS (SELECT DISTINCT regexp_replace(l.contact_phone,'[^0-9]','','g') AS phone
      FROM cloud_consent_log l,cutoff WHERE l.event='opt_out' AND l.metadata->>'campaign_id'=$1::text AND l.created_at>=cutoff.at)
    SELECT (SELECT COUNT(*)::int FROM delivered) AS delivered,
      (SELECT COUNT(*)::int FROM optouts JOIN delivered USING(phone)) AS optouts,
      COUNT(*)::int AS attempts,COUNT(*) FILTER(WHERE ecosystem AND NOT delivered)::int AS ecosystem FROM dedup`, [campaignId])
  if (!stats) return
  const t = CAMPAIGN_RISK_THRESHOLDS
  if (stats.delivered >= t.minimumDelivered && stats.optouts >= t.minimumOptOuts && stats.optouts/stats.delivered >= t.optOutRate)
    await raiseRiskIncident({ scopeType:'campaign',scopeId:campaignId,source:'panel',signal:'panel_opt_out_rate',
      title:'Aumento de solicitudes de baja',detail:'Se alcanzó el umbral preventivo de bajas de esta campaña. Revisá consentimiento, audiencia y contenido.',
      metrics:{ ...stats,optOutRate:stats.optouts/stats.delivered,windowHours:24,threshold:t.optOutRate,minimumSample:t.minimumDelivered } })
  if (stats.attempts >= t.minimumAttempts && stats.ecosystem >= t.minimumEcosystemErrors && stats.ecosystem/stats.attempts >= t.ecosystemErrorRate)
    await raiseRiskIncident({ scopeType:'campaign',scopeId:campaignId,source:'panel',signal:'panel_ecosystem_rate',
      title:'Aumento de rechazos preventivos de Meta',detail:'Meta devolvió demasiados rechazos 131049. Se pausó la campaña para revisar frecuencia y audiencia.',
      metrics:{ ...stats,ecosystemErrorRate:stats.ecosystem/stats.attempts,windowHours:24,threshold:t.ecosystemErrorRate,minimumSample:t.minimumAttempts } })
}

export async function recordCampaignProviderRisk(input: { campaignId?: string; phoneNumberId: string; templateName?: string; errorCode: number; errorMessage?: string }): Promise<void> {
  if (input.errorCode === 131049) { if(input.campaignId) await evaluateCampaignRisk(input.campaignId); return }
  if (![368,131031,131048,132015,132016].includes(input.errorCode)) return
  const [number] = await query<{ waba_id: string }>('SELECT waba_id FROM cloud_numbers WHERE phone_number_id=$1',[input.phoneNumberId])
  const template = [132015,132016].includes(input.errorCode)
  const scopeType: Scope = template && number && input.templateName ? 'template' : input.errorCode===131048 ? 'phone' : number ? 'waba' : 'phone'
  const scopeId = scopeType==='template' ? `${number.waba_id}:${input.templateName}` : scopeType==='waba' ? number.waba_id : input.phoneNumberId
  await raiseRiskIncident({ scopeType,scopeId,source:'meta',
    signal:template ? 'meta_template_status' : input.errorCode===131048 ? 'meta_phone_quality' : 'meta_account_restriction',
    title:template ? 'Meta detuvo la plantilla' : 'Meta rechazó el envío por una restricción',
    detail:`Se detuvieron las campañas afectadas por el error ${input.errorCode}. Revisá el estado de la cuenta, línea o plantilla en Meta.`,
    metrics:{ errorCode:input.errorCode } })
  // Ensure a pre-routing rejection is also visible on the campaign that triggered it.
  if (input.campaignId) await withTransaction(async db => { await riskLock(db); await attachSignals(db,[input.campaignId!]) })
}
