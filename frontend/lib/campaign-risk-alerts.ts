import type { PoolClient } from 'pg'
import { query, withTransaction } from '@/lib/db'
import type { WebhookStatus } from '@/lib/cloud-api/types/webhooks'

type DB = Pick<PoolClient, 'query'>
export type RiskAlertConfig = { destination: string; phoneNumberId: string; templateName: string; language: string; templateId?: string }
export type RiskAlertStatus = 'pending'|'preparing'|'sending'|'sent'|'delivered'|'read'|'blocked'|'failed'|'uncertain'|'skipped'
export type CampaignRiskWhatsAppAlertSummary = { id: string; incidentId: string; status: RiskAlertStatus; detail: string|null; updatedAt: string }
export type RiskAlertJob = { id: string; incident_id: string; campaign_id: string; destination: string; phone_number_id: string;
  template_name: string; template_language: string; template_id: string|null; payload: unknown; status: RiskAlertStatus;
  attempt_token: string; attempts: number; provider_message_id: string|null }

export function getRiskAlertConfig(): RiskAlertConfig|null {
  const destination = process.env.RISK_ALERT_WHATSAPP_TO?.trim() ?? ''
  const phoneNumberId = process.env.RISK_ALERT_WHATSAPP_PHONE_NUMBER_ID?.trim() ?? ''
  const templateName = process.env.RISK_ALERT_WHATSAPP_TEMPLATE_NAME?.trim() ?? ''
  const language = process.env.RISK_ALERT_WHATSAPP_LANGUAGE?.trim() ?? ''
  const templateId = process.env.RISK_ALERT_WHATSAPP_TEMPLATE_ID?.trim() || undefined
  if (!/^\+[1-9]\d{6,14}$/.test(destination) || !/^\d{5,30}$/.test(phoneNumberId)
    || !/^[a-z0-9_]{1,512}$/.test(templateName) || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)
    || (templateId && !/^\d{5,30}$/.test(templateId))) return null
  return { destination,phoneNumberId,templateName,language,templateId }
}

// This runs inside the risk/pause transaction; it never contacts Meta.
export async function enqueueCampaignRiskWhatsAppAlerts(db: DB, campaignIds?: string[]): Promise<void> {
  const config = getRiskAlertConfig()
  if (!config) return
  await db.query(`INSERT INTO campaign_risk_whatsapp_alerts
      (incident_id,campaign_id,destination,phone_number_id,template_name,template_language,template_id,payload)
    SELECT i.id,i.campaign_id,$2,$3,$4,$5,$6,$7::jsonb FROM (
      SELECT DISTINCT ON(campaign_id) id,campaign_id FROM campaign_risk_incidents
      WHERE resolved_at IS NULL AND ($1::uuid[] IS NULL OR campaign_id=ANY($1::uuid[]))
      ORDER BY campaign_id,detected_at,id) i
    ON CONFLICT(incident_id,destination) DO NOTHING`, [campaignIds ?? null,config.destination,config.phoneNumberId,
    config.templateName,config.language,config.templateId ?? null,
    JSON.stringify({ name:config.templateName,language:{code:config.language},components:[] })])
}

const details: Record<string,string> = {
  preflight_unavailable:'No se pudo verificar la línea o plantilla. Se volverá a comprobar sin enviar mientras tanto.',
  sender_unavailable:'La línea configurada no está habilitada para enviar la alerta.',
  risk_blocked:'El envío de la alerta está detenido por el control de seguridad de Meta.',
  opted_out:'El destinatario tiene una baja registrada; no se envió la alerta.',
  configuration_changed:'Cambió la configuración del canal de avisos; este intento no se envió.',
  incident_resolved:'La pausa ya fue revisada antes del aviso; no se envió la alerta.',
  interrupted_before_send:'Se interrumpió la preparación. Se volverá a comprobar antes de enviar.',
  provider_rejected:'Meta rechazó la alerta. Revisá el canal de avisos.',
  provider_rate_limit:'Meta pidió esperar; el intento rechazado podrá reintentarse.',
  delivery_failed:'Meta informó que la alerta no pudo entregarse.',
  provider_uncertain:'No se pudo confirmar el envío. No se reintenta automáticamente para evitar duplicados.',
}
export async function getCampaignRiskWhatsAppAlerts(campaignId: string): Promise<CampaignRiskWhatsAppAlertSummary[]> {
  const rows = await query<{id:string;incident_id:string;status:RiskAlertStatus;detail_code:string|null;updated_at:Date|string}>(
    `SELECT id,incident_id,status,detail_code,updated_at FROM campaign_risk_whatsapp_alerts
     WHERE campaign_id=$1 ORDER BY created_at DESC,id LIMIT 30`, [campaignId])
  return rows.map(r=>({id:r.id,incidentId:r.incident_id,status:r.status,detail:r.detail_code?details[r.detail_code]??null:null,
    updatedAt:new Date(r.updated_at).toISOString()}))
}

async function receiptLock(db: DB, phoneNumberId: string, providerId: string): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(158,hashtext($1))',[JSON.stringify([phoneNumberId,providerId])])
}
async function applyReceipt(db: DB, phoneNumberId: string, providerId: string): Promise<void> {
  await db.query(`UPDATE campaign_risk_whatsapp_alerts a SET status=r.status,
      detail_code=CASE WHEN r.status='failed' THEN 'delivery_failed' ELSE NULL END,
      delivery_updated_at=r.occurred_at,updated_at=now()
    FROM campaign_risk_whatsapp_receipts r
    WHERE r.phone_number_id=$1 AND r.provider_message_id=$2
      AND a.phone_number_id=r.phone_number_id AND a.provider_message_id=r.provider_message_id
      AND regexp_replace(a.destination,'[^0-9]','','g')=r.recipient_phone
      AND (array_position(ARRAY['sending','uncertain','sent','failed','delivered','read'],r.status)
          > array_position(ARRAY['sending','uncertain','sent','failed','delivered','read'],a.status)
        OR (r.status=a.status AND (a.delivery_updated_at IS NULL OR r.occurred_at>=a.delivery_updated_at)))`, [phoneNumberId,providerId])
  // The same durable receipt repairs history after an early webhook or delayed HTTP completion.
  await db.query(`UPDATE cloud_messages m SET status=a.status,
      delivered_at=CASE WHEN a.status IN ('delivered','read') THEN COALESCE(m.delivered_at,a.delivery_updated_at) ELSE m.delivered_at END,
      read_at=CASE WHEN a.status='read' THEN COALESCE(m.read_at,a.delivery_updated_at) ELSE m.read_at END,
      failed_at=CASE WHEN a.status='failed' THEN COALESCE(m.failed_at,a.delivery_updated_at) ELSE m.failed_at END
    FROM campaign_risk_whatsapp_alerts a WHERE a.phone_number_id=$1 AND a.provider_message_id=$2
      AND m.id=a.attempt_token AND a.status IN ('sent','failed','delivered','read')
      AND NOT(m.status='read' AND a.status<>'read')
      AND NOT(m.status='delivered' AND a.status IN ('sent','failed'))`,[phoneNumberId,providerId])
}

// Called only after signature/app/WABA/sender validation by the webhook route.
export async function recordCampaignRiskAlertDelivery(phoneNumberId: string, event: WebhookStatus): Promise<void> {
  if (!['sent','delivered','read','failed'].includes(event.status)) return
  if (!event.id || !/^\d{1,12}$/.test(event.timestamp) || !event.recipient_id) return
  const recipient = event.recipient_id.replace(/\D/g,'')
  if (!recipient) return
  const occurred = new Date(Number(event.timestamp)*1000)
  if (!Number.isFinite(occurred.getTime())) return
  await withTransaction(async db=>{
    await receiptLock(db,phoneNumberId,event.id)
    await db.query(`INSERT INTO campaign_risk_whatsapp_receipts(phone_number_id,provider_message_id,recipient_phone,status,occurred_at)
      SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM campaign_risk_whatsapp_alerts a
        WHERE a.phone_number_id=$1 AND regexp_replace(a.destination,'[^0-9]','','g')=$3
          AND (a.provider_message_id=$2 OR (a.provider_message_id IS NULL AND a.status IN ('sending','uncertain')
            AND a.started_at>now()-interval '5 minutes')))
      ON CONFLICT(phone_number_id,provider_message_id) DO UPDATE SET status=EXCLUDED.status,occurred_at=EXCLUDED.occurred_at,updated_at=now()
      WHERE campaign_risk_whatsapp_receipts.recipient_phone=EXCLUDED.recipient_phone AND (
        array_position(ARRAY['sent','failed','delivered','read'],EXCLUDED.status)
          > array_position(ARRAY['sent','failed','delivered','read'],campaign_risk_whatsapp_receipts.status)
        OR (EXCLUDED.status=campaign_risk_whatsapp_receipts.status AND EXCLUDED.occurred_at>=campaign_risk_whatsapp_receipts.occurred_at))`,
    [phoneNumberId,event.id,recipient,event.status,occurred])
    await applyReceipt(db,phoneNumberId,event.id)
  })
}

export async function completeCampaignRiskAlert(job: RiskAlertJob, result: {
  status: 'sent'|'blocked'|'failed'|'uncertain'|'skipped'; detailCode?: string; providerId?: string; retryAfterMs?: number
}): Promise<void> {
  await withTransaction(async db=>{
    if(result.providerId) await receiptLock(db,job.phone_number_id,result.providerId)
    const rows=await db.query(`UPDATE campaign_risk_whatsapp_alerts SET status=$3,detail_code=$4,
        provider_message_id=COALESCE(provider_message_id,$5),finished_at=now(),updated_at=now(),
        next_attempt_at=now()+($6*interval '1 millisecond')
      WHERE id=$1 AND attempt_token=$2 AND status IN ('preparing','sending') RETURNING id`,
    [job.id,job.attempt_token,result.status,result.detailCode??null,result.providerId??null,result.retryAfterMs??300000])
    if(!rows.rows.length) return
    if(result.providerId) {
      await db.query(`UPDATE cloud_messages SET wamid=$2,status=CASE WHEN status IN ('delivered','read') THEN status ELSE 'sent' END,
        sent_at=COALESCE(sent_at,now()) WHERE id=$1 AND (wamid IS NULL OR wamid=$2)`,[job.attempt_token,result.providerId])
      await applyReceipt(db,job.phone_number_id,result.providerId)
    } else if(result.status!=='uncertain') {
      await db.query(`UPDATE cloud_messages SET status='failed',failed_at=now(),error_title=$2,
        error_details='La alerta no fue enviada o Meta la rechazó.' WHERE id=$1 AND status='queued' AND wamid IS NULL`,
      [job.attempt_token,result.detailCode??'alert-not-sent'])
    }
  })
}
