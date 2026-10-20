import type { PoolClient } from 'pg'
import { query, withTransaction } from '@/lib/db'
import { normalizePhone } from '@/lib/validate'
import { OptOutError } from '@/lib/cloud-api/errors'
import { resolveConsentIdentity, type ConsentContext } from './consent-context'
import { evaluateCampaignRisk } from './campaign-risk'

export const OPT_OUT_REASON = 'Baja solicitada por el contacto'
export const OPT_OUT_CANCELLED = 'agent-opt-out'
function phoneKey(phone:string):string {
  const key=normalizePhone(phone)
  if(!key || !/^\d+$/.test(key)) throw new Error('Teléfono inválido')
  return key
}
async function lockPhone(db:PoolClient,phone:string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`global-opt-out:${phone}`])
}
// Keep the lock shared across agents: it also serializes manual global blocks.
const blockedSql=`SELECT 1 FROM blacklist WHERE phone_number_normalized=$1::text AND removed_at IS NULL
  AND (scope_key='global' OR agent_code=$2::text OR ($2::text IS NULL AND agent_code IS NOT NULL) OR (agent_code IS NULL AND source_key=$3::text))
  UNION ALL SELECT 1 FROM cloud_opt_outs WHERE contact_phone IN($1::text,'+'||$1::text) AND opted_out=true
    AND (scope_key='global' OR agent_code=$2::text OR ($2::text IS NULL AND agent_code IS NOT NULL) OR scope_key='source:'||$3::text) LIMIT 1`
export async function isGloballyOptedOut(phone:string,context:ConsentContext={}):Promise<boolean> {
  const key=phoneKey(phone),identity=await resolveConsentIdentity(key,context)
  return (await query(blockedSql,[key,identity.agent,identity.sourceKey])).length>0
}
export async function withGlobalSendGuard<T>(phone:string,send:(db:PoolClient)=>Promise<T>,context:ConsentContext={}):Promise<T> {
  const key=phoneKey(phone)
  return withTransaction(async db=>{
    await lockPhone(db,key)
    const identity=await resolveConsentIdentity(key,context,db)
    if((await db.query(blockedSql,[key,identity.agent,identity.sourceKey])).rows.length) throw new OptOutError(key)
    return send(db)
  })
}
export async function recordGlobalOptOut(opts:{phone:string;sourceId:string;messageId?:string;text?:string;
  provider:'cloud'|'evolution';metadata?:Record<string,unknown>;agentUserId?:string;confirmation?:boolean}):Promise<void> {
  const key=phoneKey(opts.phone),sourceId=opts.provider==='cloud'?opts.sourceId:`evolution:${opts.sourceId}`
  const campaignId = await withTransaction(async db=>{
    await lockPhone(db,key)
    if(opts.messageId) {
      const existing = await db.query<{campaign_id:string|null}>(`SELECT metadata->>'campaign_id' AS campaign_id FROM cloud_consent_log WHERE contact_phone=$1 AND phone_number_id=$2
        AND message_wamid=$3 AND event='opt_out' LIMIT 1`,['+'+key,sourceId,opts.messageId])
      if(existing.rows.length) return existing.rows[0].campaign_id
    }
    const identity=await resolveConsentIdentity(key,{provider:opts.provider,sourceId:opts.sourceId,messageId:opts.messageId,
      contextWamid:typeof opts.metadata?.context_wamid==='string'?opts.metadata.context_wamid:undefined},db)
    const scopeKey=identity.agent?`agent:${identity.agent}`:`source:${identity.sourceKey}`
    const inserted=await db.query<{id:string}>(`INSERT INTO blacklist
      (phone_number_raw,phone_number_normalized,reason,source,original_message,campaign_id,agent_code,source_key,scope_key)
      VALUES($1,$2,$3,'automatic',$4,$5,$6,$7,$8)
      ON CONFLICT(phone_number_normalized,scope_key) WHERE removed_at IS NULL DO UPDATE SET
        reason=EXCLUDED.reason,original_message=EXCLUDED.original_message,campaign_id=COALESCE(EXCLUDED.campaign_id,blacklist.campaign_id)
      RETURNING id`,[opts.phone,key,OPT_OUT_REASON,opts.text?.slice(0,500)??null,identity.campaignId,identity.agent,identity.sourceKey,scopeKey])
    await db.query(`INSERT INTO cloud_opt_outs(contact_phone,phone_number_id,opted_out,opted_out_at,reason,agent_code,scope_key)
      VALUES($1,$2,true,NOW(),'stop_keyword',$3,$4) ON CONFLICT(contact_phone,phone_number_id) DO UPDATE SET
      opted_out=true,opted_out_at=NOW(),reason='stop_keyword',agent_code=EXCLUDED.agent_code,scope_key=EXCLUDED.scope_key`,
      ['+'+key,sourceId,identity.agent,scopeKey])
    await db.query(`INSERT INTO cloud_consent_log(contact_phone,phone_number_id,event,source,message_wamid,agent_user_id,metadata)
      VALUES($1,$2,'opt_out',$3,$4,$5,$6::jsonb)`,['+'+key,sourceId,opts.messageId?'inbound_message':'agent_action',opts.messageId??null,opts.agentUserId??null,
      JSON.stringify({...opts.metadata,provider:opts.provider,scope:identity.agent?'agent':'source',agent_code:identity.agent,
        source_key:identity.sourceKey,blacklist_id:inserted.rows[0].id,campaign_id:identity.campaignId,needs_review:!identity.agent,
        confirmation:opts.confirmation && opts.messageId && opts.text?.trim().toUpperCase()==='BAJA'?{status:'pending'}:undefined})])
    if(identity.agent) {
      await db.query(`UPDATE campaign_recipients SET status='skipped',locked_at=NULL,error_detail=$3,updated_at=NOW()
        WHERE regexp_replace(phone_number,'[^0-9]','','g')=$1 AND agent_code=$2 AND status='pending'`,[key,identity.agent,OPT_OUT_REASON])
    }
    await db.query(`UPDATE automation_message_jobs SET status='skipped',finished_at=NOW(),details=$4 WHERE phone=$1 AND status='queued'
      AND (agent_code=$2 OR ($2::text IS NULL AND provider||':'||source_id=$3))`,[key,identity.agent,identity.sourceKey,OPT_OUT_REASON])
    await db.query(`UPDATE cloud_messages m SET status='failed',failed_at=NOW(),error_code=NULL,error_title=$4,error_details=$5
      FROM cloud_conversations c WHERE m.conversation_id=c.id AND c.contact_phone IN($1,'+'||$1)
      AND m.direction='outbound' AND m.status='queued' AND m.wamid IS NULL
      AND (m.content->>'agentCode'=$2 OR EXISTS(SELECT 1 FROM campaign_recipients r WHERE r.campaign_id=m.campaign_id
        AND regexp_replace(r.phone_number,'[^0-9]','','g')=$1 AND r.agent_code=$2)
        OR ($2::text IS NULL AND 'cloud:'||m.phone_number_id=$3))`,[key,identity.agent,identity.sourceKey,OPT_OUT_CANCELLED,OPT_OUT_REASON])
    return identity.campaignId
  })
  // After consent commits: persistence failure can be retried without losing the baja.
  if(campaignId) await evaluateCampaignRisk(campaignId)
}
export async function reinstateGlobalContact(id:string,userId:string,consent:string):Promise<boolean> {
  if(consent.trim().length<10) throw new Error('Registrá el nuevo consentimiento del contacto (al menos 10 caracteres).')
  return withTransaction(async db=>{
    const {rows}=await db.query<{phone_number_normalized:string;scope_key:string;agent_code:string|null}>(
      'SELECT phone_number_normalized,scope_key,agent_code FROM blacklist WHERE id=$1 AND removed_at IS NULL',[id])
    if(!rows.length) return false
    const entry=rows[0],key=entry.phone_number_normalized
    await lockPhone(db,key)
    if(!(await db.query('UPDATE blacklist SET removed_at=NOW(),removed_by=$2 WHERE id=$1 AND removed_at IS NULL RETURNING id',[id,userId])).rows.length) return false
    await db.query(`UPDATE cloud_opt_outs SET opted_out=false,opted_out_at=NULL,reason=NULL
      WHERE contact_phone IN($1,'+'||$1) AND scope_key=$2`,[key,entry.scope_key])
    await db.query(`INSERT INTO cloud_consent_log(contact_phone,phone_number_id,event,channel,source,agent_user_id,metadata)
      VALUES($1,$2,'reinstated','manual','agent_action',$3,$4::jsonb)`,['+'+key,entry.scope_key,userId,
      JSON.stringify({blacklist_id:id,scope:entry.scope_key,agent_code:entry.agent_code,consent:consent.trim()})])
    return true
  })
}
