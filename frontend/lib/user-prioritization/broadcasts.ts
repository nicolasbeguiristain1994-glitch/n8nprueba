import { createHash } from 'crypto'
import { z } from 'zod'
import { query, withTransaction } from '@/lib/db'
import { contactScope } from '@/lib/contact-visibility'
import { canAccess } from '@/lib/permissions'
import { CampaignTemplateParamsSchema, validateCampaignTemplate } from '@/lib/campaign-template'
import { getAccessibleLineIds } from '@/lib/line-visibility'
import type { SessionUser } from '@/lib/auth'

export const PriorityBroadcastSchema = z.object({
  request_id: z.string().uuid(),
  contact_ids: z.array(z.string().uuid()).min(1).max(200),
  template_id: z.string().uuid(),
  template_params: CampaignTemplateParamsSchema.default({}),
}).strict()
export class PriorityBroadcastError extends Error {
  constructor(message: string, public status=409) { super(message) }
}
// Aliases: batch campaign bc, recipient br, message bm. Failed recipients stay
// in their original campaign for safe retries. Cancellation releases definite
// failures only after the worker stops. Unknown provider outcomes stay fenced.
export const PRIORITY_BUSY_SQL = `(bc.processor_locked_at IS NOT NULL OR br.status='sending'
  OR bm.status='queued'
  OR COALESCE(bm.error_detail,'') LIKE '[provider-outcome-unknown-no-resend]%'
  OR COALESCE(bm.error_detail,'') LIKE 'stale-queued-no-resend%'
  OR COALESCE(br.error_detail,'') LIKE '[provider-outcome-unknown-no-resend]%'
  OR COALESCE(br.error_detail,'') LIKE 'stale-queued-no-resend%'
  OR bc.status IN ('draft','scheduled','running','paused')
  OR (bc.status='completed' AND COALESCE(br.status,'pending')<>'sent'))`
export const PRIORITY_BATCH_JOINS = `JOIN campaigns bc ON bc.id=pb.campaign_id
  JOIN campaign_audience_members ba ON ba.campaign_id=bc.id
  LEFT JOIN campaign_recipients br ON br.campaign_id=bc.id AND br.contact_id=ba.contact_id
  LEFT JOIN whatsapp_messages bm ON bm.campaign_recipient_id=br.id`

export async function preparePriorityBroadcast(user: SessionUser, data: z.infer<typeof PriorityBroadcastSchema>) {
  const ids=[...new Set(data.contact_ids)].sort()
  const hash=createHash('sha256').update(JSON.stringify({ids,template:data.template_id,params:data.template_params})).digest('hex')
  const lines=await getAccessibleLineIds(user)
  return withTransaction(async client=>{
    // Same request ID never produces another campaign, even after a lost response.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,147))",[data.request_id])
    const {rows:[existing]}=await client.query(`SELECT pb.request_hash,c.owned_by FROM priority_broadcasts pb
      JOIN campaigns c ON c.id=pb.campaign_id WHERE pb.campaign_id=$1`,[data.request_id])
    if(existing) {
      if(existing.owned_by!==user.user_id || existing.request_hash!==hash) throw new PriorityBroadcastError('Esta solicitud ya se usó con otra selección o plantilla')
      return {campaign_id:data.request_id,reused:true}
    }
    const scope=contactScope(user,1,'c')
    const {rows}=await client.query<{id:string}>(`SELECT c.id FROM contacts c JOIN contact_priority_scores cps ON cps.contact_id=c.id
      WHERE c.id=ANY($1::uuid[]) AND ${scope.sql} AND cps.is_eligible=true AND cps.is_broadcasted=false
        AND (cps.run_id=(SELECT last_complete_run_id FROM system_jobs WHERE job_name='prioritization_recompute')
          OR (SELECT last_complete_run_id FROM system_jobs WHERE job_name='prioritization_recompute') IS NULL)
        AND c.status IN ('active','inactive') AND c.opt_in_marketing=true AND c.do_not_contact=false
        AND NOT EXISTS(SELECT 1 FROM blacklist b WHERE b.removed_at IS NULL AND b.phone_number_normalized IN (c.phone_number,regexp_replace(c.phone_number,'[^0-9]','','g')))
      ORDER BY c.id FOR UPDATE OF cps`,[ids,...scope.params])
    if(rows.length!==ids.length) throw new PriorityBroadcastError('La selección cambió o incluye contactos no disponibles. Actualizá Prioridades y revisala.')
    const {rows:busy}=await client.query(`SELECT 1 FROM priority_broadcasts pb ${PRIORITY_BATCH_JOINS}
      WHERE ba.contact_id=ANY($1::uuid[]) AND ${PRIORITY_BUSY_SQL} LIMIT 1`,[ids])
    if(busy.length) throw new PriorityBroadcastError('Hay contactos con una difusión pendiente o que requiere revisión. Continuá esa difusión antes de crear otra.')
    const {rows:[template]}=await client.query<{name:string;status:string;waba_id:string|null;components:unknown}>(
      'SELECT name,status,waba_id,components FROM whatsapp_templates WHERE id=$1',[data.template_id])
    if(!template || template.status!=='APROBADA' || !template.waba_id) throw new PriorityBroadcastError('Seleccioná una plantilla aprobada y sincronizada con WhatsApp',400)
    const {rows:available}=await client.query(`SELECT id FROM cloud_numbers WHERE waba_id=$1 AND status='active'
      AND ($2::uuid[] IS NULL OR whatsapp_line_id=ANY($2::uuid[])) LIMIT 1`,[template.waba_id,lines])
    if(!available.length) throw new PriorityBroadcastError('No tenés una línea habilitada para esta plantilla',403)
    const error=validateCampaignTemplate(template.components,data.template_params)
    if(error) throw new PriorityBroadcastError(error,400)
    const name=`Prioridades · ${new Date().toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires'})}`
    const {rows:[list]}=await client.query<{id:string}>(`INSERT INTO contact_lists(name,description,contact_count,owned_by,source)
      VALUES($1,'Selección fija desde Prioridades',$2,$3,'priorities') RETURNING id`,[name,ids.length,user.user_id])
    await client.query(`INSERT INTO contact_list_members(list_id,contact_id) SELECT $1,unnest($2::uuid[])`,[list.id,ids])
    await client.query(`INSERT INTO campaigns(id,name,message,messages,list_id,type,status,total_targets,
      antiblock_delay_min,antiblock_delay_max,personalize_name,use_multi_line,owned_by,updated_by,message_type,
      template_id,template_params,audience_snapshot_at,is_priority_broadcast)
      VALUES($1,$2,$3,$4::jsonb,$5,'promotion','draft',$6,3,8,true,true,$7,$7,'template',$8,$9::jsonb,NOW(),true)`,
      [data.request_id,name,`[plantilla:${template.name}]`,JSON.stringify([`[plantilla:${template.name}]`]),list.id,ids.length,user.user_id,data.template_id,JSON.stringify(data.template_params)])
    await client.query(`INSERT INTO campaign_audience_members(campaign_id,contact_id) SELECT $1,unnest($2::uuid[])`,[data.request_id,ids])
    await client.query(`INSERT INTO campaign_recipients(campaign_id,contact_id,phone_number) SELECT $1,id,phone_number FROM contacts WHERE id=ANY($2::uuid[])`,[data.request_id,ids])
    await client.query('INSERT INTO priority_broadcasts(campaign_id,request_hash,actor_name) VALUES($1,$2,$3)',[data.request_id,hash,user.name||user.email||'Operador'])
    return {campaign_id:data.request_id,reused:false}
  })
}

/** Revalidate visibility and consent just before each priority send, failing closed. */
export async function priorityRecipientAllowed(campaignId:string,contactId:string,phone:string) {
  const [user]=await query<SessionUser & {is_active:boolean}>(`SELECT u.*,u.id AS user_id FROM users u
    JOIN campaigns bc ON bc.owned_by=u.id WHERE bc.id=$1`,[campaignId])
  if(!user?.is_active || !canAccess(user,'contacts','read') || !canAccess(user,'send','send')) return false
  const scope=contactScope(user,3,'c')
  const allowed=await query(`SELECT 1 FROM contacts c
    JOIN campaign_audience_members ba ON ba.contact_id=c.id AND ba.campaign_id=$1
    WHERE c.id=$2 AND c.phone_number=$3 AND ${scope.sql}
      AND c.status IN ('active','inactive') AND c.opt_in_marketing=true AND c.do_not_contact=false
      AND NOT EXISTS(SELECT 1 FROM blacklist b WHERE b.removed_at IS NULL AND b.phone_number_normalized IN (c.phone_number,regexp_replace(c.phone_number,'[^0-9]','','g')))`,[campaignId,contactId,phone,...scope.params])
  return allowed.length>0
}
