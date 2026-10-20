import { query, withTransaction } from '@/lib/db'
import { isGloballyOptedOut } from '@/lib/global-opt-out'
import { CampaignRiskError, assertCloudSendRiskClear } from '@/lib/campaign-risk'
import { getTokenForNumber } from '@/lib/cloud-api/token-store'
import { enforceRateLimit } from '@/lib/cloud-api/rate-limiter'
import { MessageSenderService } from '@/lib/cloud-api/infrastructure/message-sender.service'
import { CloudApiError, OptOutError } from '@/lib/cloud-api/errors'
import { refreshOperationalAlertMeta } from '@/lib/cloud-api/meta-risk-refresh'
import type { SendMessageRequest } from '@/lib/cloud-api/types/messages'
import { completeCampaignRiskAlert, enqueueCampaignRiskWhatsAppAlerts, getRiskAlertConfig,
  type RiskAlertConfig, type RiskAlertJob } from '@/lib/campaign-risk-alerts'

const RETRY_MS = 5 * 60_000
const sameConfig = (job: RiskAlertJob, config: RiskAlertConfig) => job.destination === config.destination
  && job.phone_number_id === config.phoneNumberId && job.template_name === config.templateName
  && job.template_language === config.language && job.template_id === (config.templateId ?? null)

async function claim(): Promise<RiskAlertJob|undefined> {
  return withTransaction(async db=>{
    // A preparing worker has not crossed the durable HTTP fence. A sending
    // worker might have, so interruption can never authorize a resend.
    await db.query(`UPDATE campaign_risk_whatsapp_alerts SET status=CASE WHEN status='sending' THEN 'uncertain' ELSE 'blocked' END,
      detail_code=CASE WHEN status='sending' THEN 'provider_uncertain' ELSE 'interrupted_before_send' END,
      next_attempt_at=now(),updated_at=now(),finished_at=now()
      WHERE status IN ('preparing','sending') AND started_at<now()-interval '5 minutes'`)
    await enqueueCampaignRiskWhatsAppAlerts(db)
    const result=await db.query<RiskAlertJob>(`WITH next AS (
      SELECT a.id FROM campaign_risk_whatsapp_alerts a WHERE a.status IN ('pending','blocked') AND a.next_attempt_at<=now()
      ORDER BY a.next_attempt_at,a.created_at,a.id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE campaign_risk_whatsapp_alerts a SET status='preparing',attempt_token=gen_random_uuid(),
        attempts=attempts+1,started_at=now(),finished_at=NULL,updated_at=now()
      FROM next WHERE a.id=next.id RETURNING a.*`)
    return result.rows[0]
  })
}

async function prepareHistory(job: RiskAlertJob, request: SendMessageRequest): Promise<boolean> {
  return withTransaction(async db=>{
    const current=await db.query(`SELECT a.id FROM campaign_risk_whatsapp_alerts a
      JOIN campaign_risk_incidents i ON i.id=a.incident_id AND i.resolved_at IS NULL
      WHERE a.id=$1 AND a.attempt_token=$2 AND a.status='preparing' FOR UPDATE OF a`, [job.id,job.attempt_token])
    if(!current.rows.length) return false
    // Preserve the configured line's admin switch and local capacity, including
    // racing campaign reservations. A rejected attempt still counts as usage.
    const line=await db.query(`UPDATE whatsapp_lines wl SET msgs_sent_hour=msgs_sent_hour+1,msgs_sent_today=msgs_sent_today+1,
      hour_reset_at=COALESCE(hour_reset_at,now()+interval '1 hour'),day_reset_at=COALESCE(day_reset_at,now()+interval '24 hours'),updated_at=now()
      FROM cloud_numbers cn WHERE cn.whatsapp_line_id=wl.id AND cn.phone_number_id=$1 AND cn.status='active'
        AND wl.line_type='cloud' AND wl.status='active' AND wl.is_connected AND wl.sending_enabled
        AND wl.msgs_sent_hour<wl.msg_per_hour AND wl.msgs_sent_today<wl.msg_per_day RETURNING wl.id`, [job.phone_number_id])
    if(!line.rows.length) return false
    const conversation=await db.query<{id:string}>(`INSERT INTO cloud_conversations(phone_number_id,contact_phone,status,last_message_at)
      VALUES($1,$2,'open',now()) ON CONFLICT(phone_number_id,contact_phone) DO UPDATE SET last_message_at=now(),updated_at=now() RETURNING id`,
    [job.phone_number_id,job.destination])
    await db.query(`INSERT INTO cloud_messages(id,conversation_id,phone_number_id,direction,message_type,content,status,queued_at,template_name)
      VALUES($1,$2,$3,'outbound','template',$4::jsonb,'queued',now(),$5)`,
    [job.attempt_token,conversation.rows[0].id,job.phone_number_id,
      JSON.stringify({...request,source:'campaign_risk_alert',risk_alert_id:job.id,risk_incident_id:job.incident_id}),job.template_name])
    await db.query(`UPDATE campaign_risk_whatsapp_alerts SET status='sending',payload=$3::jsonb,updated_at=now()
      WHERE id=$1 AND attempt_token=$2 AND status='preparing'`,[job.id,job.attempt_token,JSON.stringify(request.template)])
    return true
  })
}

async function processJob(job: RiskAlertJob, config: RiskAlertConfig): Promise<void> {
  if(!sameConfig(job,config)) {
    await completeCampaignRiskAlert(job,{status:'skipped',detailCode:'configuration_changed'}); return
  }
  const [incident]=await query(`SELECT id FROM campaign_risk_incidents WHERE id=$1 AND resolved_at IS NULL`,[job.incident_id])
  if(!incident) { await completeCampaignRiskAlert(job,{status:'skipped',detailCode:'incident_resolved'}); return }
  const request: SendMessageRequest={phoneNumberId:job.phone_number_id,to:job.destination,type:'template',
    template:{name:job.template_name,language:{code:job.template_language},components:[]}}
  let token: string
  try {
    if(await isGloballyOptedOut(job.destination,{provider:'cloud',sourceId:job.phone_number_id})) throw new OptOutError(job.destination)
    await query('SELECT reset_line_counters_if_due()')
    const [line]=await query(`SELECT wl.id FROM whatsapp_lines wl JOIN cloud_numbers cn ON cn.whatsapp_line_id=wl.id
      WHERE cn.phone_number_id=$1 AND cn.status='active' AND wl.line_type='cloud' AND wl.status='active'
        AND wl.is_connected AND wl.sending_enabled AND wl.msgs_sent_hour<wl.msg_per_hour AND wl.msgs_sent_today<wl.msg_per_day`,[job.phone_number_id])
    if(!line) { await completeCampaignRiskAlert(job,{status:'blocked',detailCode:'sender_unavailable',retryAfterMs:RETRY_MS}); return }
    // The operational template is fixed, approved UTILITY. Never attach the
    // paused campaign ID to the send or include any customer/campaign content.
    await refreshOperationalAlertMeta(job.phone_number_id,job.template_name,job.template_language,job.template_id??undefined)
    await assertCloudSendRiskClear({phoneNumberId:job.phone_number_id,templateName:job.template_name})
    await enforceRateLimit(job.phone_number_id)
    token=await getTokenForNumber(job.phone_number_id)
  } catch(error) {
    await completeCampaignRiskAlert(job,{status:error instanceof OptOutError?'skipped':'blocked',
      detailCode:error instanceof OptOutError?'opted_out':error instanceof CampaignRiskError?'risk_blocked':'preflight_unavailable',retryAfterMs:RETRY_MS})
    return
  }
  // A failed COMMIT here is ambiguous only about local preparation: no HTTP is
  // started. Recovery conservatively leaves a committed sending fence uncertain.
  const prepared=await prepareHistory(job,request)
  if(!prepared) { await completeCampaignRiskAlert(job,{status:'blocked',detailCode:'sender_unavailable',retryAfterMs:RETRY_MS}); return }
  let providerId: string|undefined
  try {
    const result=await new MessageSenderService(token,job.phone_number_id).send(request)
    if(!result.wamid) throw new Error('Missing provider message ID')
    providerId=result.wamid
  } catch(error) {
    const preProvider=error instanceof CampaignRiskError || error instanceof OptOutError
    const rejected=error instanceof CloudApiError && typeof error.code==='number'
    const retryable=rejected && [4,80007,130429,429].includes(error.code!) && job.attempts<4
    await completeCampaignRiskAlert(job,{
      status:error instanceof OptOutError?'skipped':preProvider||retryable?'blocked':rejected?'failed':'uncertain',
      detailCode:error instanceof OptOutError?'opted_out':preProvider?'risk_blocked':retryable?'provider_rate_limit':rejected?'provider_rejected':'provider_uncertain',
      retryAfterMs:RETRY_MS,
    })
    return
  }
  // If persistence fails after acceptance, leave the sending fence intact. A
  // restart marks it uncertain; it must never result in another provider call.
  await completeCampaignRiskAlert(job,{status:'sent',providerId})
}

export async function processCampaignRiskWhatsAppAlerts(): Promise<number> {
  const config=getRiskAlertConfig()
  if(!config) return 0
  const job=await claim()
  if(!job) return 0
  await processJob(job,config)
  return 1
}

type WorkerGlobal=typeof globalThis & { __riskWhatsAppAlertTimer?: ReturnType<typeof setInterval>; __riskWhatsAppAlertRun?: Promise<unknown> }
export function startCampaignRiskWhatsAppAlerts(): void {
  const runtime=globalThis as WorkerGlobal
  if(runtime.__riskWhatsAppAlertTimer) return
  const run=()=>{
    if(runtime.__riskWhatsAppAlertRun) return
    runtime.__riskWhatsAppAlertRun=processCampaignRiskWhatsAppAlerts().catch(()=>{
      console.warn('[campaign-risk] No se pudo procesar el aviso de WhatsApp; el intento permanece registrado')
    }).finally(()=>{delete runtime.__riskWhatsAppAlertRun})
  }
  runtime.__riskWhatsAppAlertTimer=setInterval(run,15_000)
  runtime.__riskWhatsAppAlertTimer.unref?.()
  run()
}
