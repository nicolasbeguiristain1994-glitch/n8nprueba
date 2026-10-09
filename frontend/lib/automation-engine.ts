import { isOfizeus, ofizeusReply, type RoutingContact } from '@/lib/contact-line-directory'
import { query, withTransaction } from '@/lib/db'
import { sendMessageUseCase } from '@/lib/cloud-api/use-cases/send-message.use-case'
import { sseEmitter } from '@/lib/sse-events'

export type AutomationSource = { provider: 'cloud'; phoneNumberId: string } | { provider: 'evolution'; instance: string }
type Rule = { id: string; name: string; type: 'reply'|'flow'|'handoff'; trigger_type: string;
  trigger_config: { keywords?: string[]; once_per_chat?: boolean }; action_config: { contact_line_directory?: 'ofizeus'; message?: string; steps?: { message: string; delay_sec?: number }[] } }
type Job = { id: string; event_key: string; automation_id: string; automation_name: string; phone: string;
  provider: 'cloud'|'evolution'; source_id: string; body: string; step: number; handoff: boolean; legacy_message_id: string|null }
const digits = (phone: string) => phone.replace(/\D/g,'')
const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim()
export function automationMatches(rule: Pick<Rule,'trigger_type'|'trigger_config'>, text: string): boolean {
  if (rule.trigger_type==='any_inbound') return true
  const keys=(rule.trigger_config.keywords??[]).filter(k=>typeof k==='string').map(normalize).filter(Boolean), value=normalize(text)
  return keys.some(k=>rule.trigger_type==='keyword'?value===k:rule.trigger_type==='contains'&&value.includes(k))
}
export function automationSteps(rule: Pick<Rule,'type'|'action_config'>): { message:string; delay_sec:number }[] {
  const raw=rule.type==='flow'?rule.action_config.steps:[{message:rule.action_config.message??''}]
  if (rule.type==='handoff' && !rule.action_config.message?.trim()) return []
  if (!Array.isArray(raw)||!raw.length||raw.length>20) throw Error('Configurá entre 1 y 20 pasos')
  return raw.map(s=>{
    if (!s || typeof s.message!=='string' || !s.message.trim() || s.message.length>4096) throw Error('Cada paso requiere un mensaje de hasta 4096 caracteres')
    const delay=s.delay_sec??0
    if (!Number.isInteger(delay)||delay<0||delay>3600) throw Error('La espera debe estar entre 0 y 3600 segundos')
    return {message:s.message.trim(),delay_sec:delay}
  })
}

// Durable unique receipt + all steps are committed together, before any provider
// call. Webhook retries can finish a queued event but cannot create another flow.
export async function evaluateAutomations(phone: string, messageText: string, messageId: string|null, source?: AutomationSource): Promise<void> {
  if (!messageId || !source || !digits(phone)) return
  const provider=source.provider, sourceId=provider==='cloud'?(source as {phoneNumberId:string}).phoneNumberId:(source as {instance:string}).instance
  if (!sourceId) return
  const eventKey=`${provider}:${sourceId}:${messageId}`, number=digits(phone)
  await withTransaction(async db=>{
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`automation:${provider}:${sourceId}:${number}`])
    const claimed=await db.query(`INSERT INTO automation_inbound_receipts(event_key,phone,provider,source_id)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_key`,[eventKey,number,provider,sourceId])
    if (!claimed.rows.length) return
    const blocked=await db.query(`SELECT 1 FROM conversation_state WHERE regexp_replace(phone_number,'[^0-9]','','g')=$1 AND resolved_at IS NULL AND is_escalated=true
      UNION ALL SELECT 1 FROM blacklist WHERE phone_number_normalized=$1 AND removed_at IS NULL LIMIT 1`,[number])
    if (blocked.rows.length) return
    const rules=await db.query<Rule>(`SELECT a.id,a.name,a.type,a.trigger_type,a.trigger_config,a.action_config
      FROM automations a JOIN users u ON u.id=a.created_by
      WHERE a.is_active=true AND u.is_active=true AND u.role='admin' ORDER BY a.priority,CASE WHEN a.action_config->>'contact_line_directory'='ofizeus' THEN 0 ELSE 1 END,a.created_at,a.id`)
    const matches=rules.rows.filter(r=>automationMatches(r,messageText))
    // Only the directory mode reads assignment fields; generic rules keep their
    // existing behavior. Two matching phone records are ambiguous, never guessed.
    let routingContacts: RoutingContact[] = []
    if (matches.some(r=>r.action_config.contact_line_directory==='ofizeus')) {
      routingContacts=(await db.query<RoutingContact>(`SELECT first_name,panel,linea,linea_sub FROM contacts
        WHERE regexp_replace(phone_number,'[^0-9]','','g')=$1 AND deleted_at IS NULL LIMIT 2`,[number])).rows
    }
    const rule=matches.find(r=>!r.action_config.contact_line_directory ||
      (r.action_config.contact_line_directory==='ofizeus' && (!routingContacts.length || routingContacts.some(isOfizeus))))
    if (!rule) return
    if (rule.type==='reply' && rule.trigger_config.once_per_chat===true) {
      // Chats in the inbox are keyed by phone, even across lines/providers.
      // Serialize different inbound events before checking the durable history.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`automation-once:${rule.id}:${number}`])
      const prior=await db.query(`SELECT 1 FROM automation_message_jobs
        WHERE automation_id=$1 AND phone=$2 AND status IN ('queued','processing','sent','uncertain') LIMIT 1`,[rule.id,number])
      if (prior.rows.length) {
        await db.query(`INSERT INTO automation_logs(automation_id,automation_name,conversation_phone,result,details)
          VALUES($1,$2,$3,'skipped','Respuesta única por chat: ya enviada o pendiente de confirmación')`,[rule.id,rule.name,number])
        return
      }
    }
    const recent=await db.query(`SELECT 1 FROM automation_message_jobs WHERE phone=$1 AND provider=$2 AND source_id=$3
      AND created_at>NOW()-interval '10 seconds' AND status IN ('queued','processing','sent')
      AND ($4::uuid IS NULL OR automation_id=$4) LIMIT 1`,[number,provider,sourceId,rule.action_config.contact_line_directory ? rule.id : null])
    if (recent.rows.length) return
    const contact=await db.query<{first_name:string|null;panel:string|null}>(`SELECT first_name,panel FROM contacts WHERE regexp_replace(phone_number,'[^0-9]','','g')=$1 LIMIT 1`,[number])
    const resolve=(message:string)=>message.replace(/\{\{nombre\}\}/gi,contact.rows[0]?.first_name?.trim()||'Cliente')
      .replace(/\{\{empresa\}\}/gi,contact.rows[0]?.panel?.trim()||'')
      .replace(/\{\{fecha\}\}/gi,new Date().toLocaleDateString('es-AR',{timeZone:'America/Argentina/Buenos_Aires'}))
    let steps: ReturnType<typeof automationSteps>
    try { steps=automationSteps(rule) } catch {
      await db.query(`INSERT INTO automation_logs(automation_id,automation_name,conversation_phone,result,details) VALUES($1,$2,$3,'error','Configuración de pasos inválida')`,[rule.id,rule.name,number]);return
    }
    let handoff=rule.type==='handoff'
    if (rule.action_config.contact_line_directory) {
      if (rule.type!=='reply' || rule.action_config.contact_line_directory!=='ofizeus') return
      const directory = await db.query<{linea:number;variant:string;label:string;phone:string}>(`SELECT linea,variant,label,phone
        FROM agent_contact_lines WHERE agent_code='ofizeus' AND is_active=true`)
      const routed=ofizeusReply(routingContacts,rule.action_config.message??'Esta es tu línea asignada:',
        directory.rows.map(line=>[line.linea,line.variant,line.label,line.phone] as const))
      if (routed.message.length>4096) {
        await db.query(`INSERT INTO automation_logs(automation_id,automation_name,conversation_phone,result,details) VALUES($1,$2,$3,'error','La respuesta con la línea supera 4096 caracteres')`,[rule.id,rule.name,number]);return
      }
      steps=[{message:routed.message,delay_sec:0}]
      handoff=routed.handoff
    }
    if (handoff) {
      await db.query(`INSERT INTO conversation_state(phone_number,is_escalated,escalated_at,escalation_reason)
        VALUES($1,true,NOW(),$2) ON CONFLICT(phone_number) WHERE resolved_at IS NULL
        DO UPDATE SET is_escalated=true,escalated_at=NOW(),escalation_reason=EXCLUDED.escalation_reason,updated_at=NOW()`,[number,`Automatización: ${rule.name}`])
      await db.query(`INSERT INTO automation_logs(automation_id,automation_name,conversation_phone,result,details) VALUES($1,$2,$3,'executed','Conversación derivada a un operador')`,[rule.id,rule.name,number])
    }
    let delay=0
    for (let i=0;i<steps.length;i++) {
      delay+=steps[i].delay_sec
      await db.query(`INSERT INTO automation_message_jobs(event_key,automation_id,automation_name,phone,provider,source_id,body,step,handoff,legacy_message_id,run_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()+($11*interval '1 second'))`,
        [eventKey,rule.id,rule.name,number,provider,sourceId,resolve(steps[i].message),i,handoff,provider==='evolution'?messageId:null,delay])
    }
  })
  await processAutomationJobs(eventKey)
}

async function complete(job:Job,status:'sent'|'failed'|'skipped'|'uncertain',details:string) {
  await withTransaction(async db=>{
    const updated=await db.query(`UPDATE automation_message_jobs SET status=$2,finished_at=NOW(),details=$3 WHERE id=$1 AND status='processing' RETURNING id`,[job.id,status,details])
    if (!updated.rows.length) return
    await db.query(`INSERT INTO automation_logs(automation_id,automation_name,conversation_phone,message_id,result,details)
      VALUES($1,$2,$3,$4,$5,$6)`,[job.automation_id,job.automation_name,job.phone,job.legacy_message_id,status==='sent'?'executed':status==='skipped'?'skipped':'error',`Paso ${job.step+1}: ${details}`])
  })
}

async function sendJob(job:Job):Promise<void> {
  // Recheck operator handoff, opt-out and active rule/creator at send time,
  // including delayed flow steps. Each reply stays on its inbound line.
  const active=await query<Pick<Rule,'type'|'trigger_config'>>(`SELECT a.type,a.trigger_config FROM automations a JOIN users u ON u.id=a.created_by WHERE a.id=$1 AND a.is_active=true AND u.is_active=true AND u.role='admin'`,[job.automation_id])
  const blocked=await query(`SELECT 1 FROM blacklist WHERE phone_number_normalized=$1 AND removed_at IS NULL
    UNION ALL SELECT 1 FROM conversation_state WHERE regexp_replace(phone_number,'[^0-9]','','g')=$1 AND resolved_at IS NULL AND is_escalated=true AND NOT $2 LIMIT 1`,[job.phone,job.handoff])
  if (!active.length||blocked.length) { await complete(job,'skipped','Regla pausada, baja solicitada o conversación atendida por un operador');return }
  if (active[0].type==='reply' && active[0].trigger_config.once_per_chat===true) {
    // The option can be enabled after multiple replies were queued. Keep only
    // the oldest eligible event; a sent/uncertain result always blocks a repeat.
    const duplicate=await withTransaction(async db=>{
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`automation-once:${job.automation_id}:${job.phone}`])
      return (await db.query(`SELECT 1 FROM automation_message_jobs prior
        WHERE prior.automation_id=$1 AND prior.phone=$2 AND prior.event_key<>$3
          AND (prior.status IN ('sent','uncertain') OR (
            prior.status IN ('queued','processing') AND (prior.created_at,prior.event_key)<
              (SELECT current.created_at,current.event_key FROM automation_message_jobs current WHERE current.id=$4)))
        LIMIT 1`,[job.automation_id,job.phone,job.event_key,job.id])).rows.length>0
    })
    if (duplicate) { await complete(job,'skipped','Respuesta única por chat: ya enviada o reservada por otro mensaje');return }
  }
  if (job.provider==='cloud') {
    const ready=await query(`SELECT 1 FROM cloud_numbers cn JOIN whatsapp_lines wl ON wl.id=cn.whatsapp_line_id
      WHERE cn.phone_number_id=$1 AND cn.status='active' AND wl.status='active' AND wl.is_connected=true AND wl.sending_enabled=true`,[job.source_id])
    if (!ready.length) {await complete(job,'skipped','La línea Cloud de origen no está habilitada');return}
    // This use case enforces opt-out, 24-hour window and rate limits, and stores
    // the outbound before making the request. Never choose another phone number.
    try {
      await sendMessageUseCase.execute({request:{phoneNumberId:job.source_id,to:'+'+job.phone,type:'text',text:{body:job.body}}})
    } catch (err) {
      const name=err instanceof Error?err.name:''
      await complete(job,['OptOutError','ConversationWindowError','TokenExpiredError'].includes(name)?'skipped':'uncertain',
        ['OptOutError','ConversationWindowError','TokenExpiredError'].includes(name)?'Baja, ventana cerrada o credencial no disponible':'Envío no confirmado; revisar el historial antes de reintentar')
      return
    }
  } else {
    const [line]=await query<{id:string;evolution_url:string;evolution_instance:string}>(`SELECT id,evolution_url,evolution_instance FROM whatsapp_lines
      WHERE evolution_instance=$1 AND line_type='evolution' AND status='active' AND is_connected=true AND sending_enabled=true LIMIT 1`,[job.source_id])
    if (!line) {await complete(job,'skipped','La línea Evolution de origen no está habilitada');return}
    const [stored]=await query<{id:string}>(`INSERT INTO whatsapp_messages(phone_number,message_body,direction,status,metadata)
      VALUES($1,$2,'outbound','queued',$3::jsonb) RETURNING id`,['+'+job.phone,job.body,JSON.stringify({line_id:line.id,source:'automation',automation_id:job.automation_id,automation_job_id:job.id})])
    let response:Response
    try {
      response=await fetch(`${line.evolution_url}/message/sendText/${line.evolution_instance}`,{method:'POST',headers:{'Content-Type':'application/json',apikey:process.env.EVOLUTION_API_KEY??''},body:JSON.stringify({number:job.phone,text:job.body}),signal:AbortSignal.timeout(20000)})
    } catch {await complete(job,'uncertain','Sin confirmación del proveedor; no se reenvía automáticamente');return}
    if (!response.ok) {
      await query(`UPDATE whatsapp_messages SET status='failed' WHERE id=$1`,[stored.id])
      await complete(job,'failed',`Proveedor rechazó el envío (HTTP ${response.status})`);return
    }
    const data=await response.json().catch(()=>null)
    await query(`UPDATE whatsapp_messages SET status='sent',evolution_message_id=$2 WHERE id=$1`,[stored.id,data?.key?.id??data?.id??null])
  }
  await complete(job,'sent','Mensaje aceptado por el proveedor')
  sseEmitter.emit('update',{source:'message'})
}

export async function processAutomationJobs(eventKey:string|null=null):Promise<number> {
  // An interrupted send is ambiguous; replaying it could duplicate a customer
  // message. Surface it for review instead of automatically reclaiming it.
  await query(`WITH stale AS (
    UPDATE automation_message_jobs SET status='uncertain',finished_at=NOW(),details='Procesamiento interrumpido; revisar antes de reintentar'
    WHERE status='processing' AND started_at<NOW()-interval '5 minutes' RETURNING *)
    INSERT INTO automation_logs(automation_id,automation_name,conversation_phone,result,details)
    SELECT automation_id,automation_name,phone,'error',details FROM stale`)
  let count=0
  for(let i=0;i<20;i++) {
    const [job]=await query<Job>(`WITH next AS (
      SELECT j.id FROM automation_message_jobs j WHERE j.status='queued' AND j.run_at<=NOW()
        AND ($1::text IS NULL OR j.event_key=$1)
        AND NOT EXISTS(SELECT 1 FROM automation_message_jobs prev WHERE prev.event_key=j.event_key AND prev.step<j.step AND prev.status IN ('queued','processing'))
      ORDER BY j.run_at,j.step,j.id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE automation_message_jobs j SET status='processing',started_at=NOW() FROM next WHERE j.id=next.id RETURNING j.*`,[eventKey])
    if (!job) break
    const failed=await query(`SELECT 1 FROM automation_message_jobs WHERE event_key=$1 AND step<$2 AND status<>'sent' LIMIT 1`,[job.event_key,job.step])
    if (failed.length) {await complete(job,'skipped','Un paso anterior no se completó');continue}
    try {await sendJob(job)} catch {await complete(job,'uncertain','Error de procesamiento; revisar antes de reintentar').catch(()=>{})}
    count++
  }
  return count
}
