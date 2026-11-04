import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { SessionUser } from './auth'
import type { CreateCampaignInput } from './schema'
import { prepareDailyBroadcast, BroadcastPlanError } from './broadcast-plan-repository'
import { broadcastPlanWindow, type BroadcastPlan } from './broadcast-planner'

export class BroadcastPlanChangedError extends BroadcastPlanError {
  constructor(public plan: BroadcastPlan) { super('El plan cambió. Revisá la nueva selección antes de guardar la campaña.',409) }
}
/** One transaction serializes creation and sender allocation for this owner. */
export async function reviewCampaignBroadcast(client: PoolClient, user: SessionUser, data: CreateCampaignInput) {
  const request = data.broadcast_plan!
  const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex')
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,147))',[request.requestId])
  const {rows:[existing]} = await client.query<{id:string;owned_by:string;status:string;request_hash:string}>(
    `SELECT id,owned_by,status,to_jsonb(campaigns)->'broadcast_plan'->>'requestHash' AS request_hash FROM campaigns WHERE id=$1`,[request.requestId])
  if (existing) {
    if (existing.owned_by !== user.user_id || existing.request_hash !== hash)
      throw new BroadcastPlanError('Esta solicitud ya se usó para otra campaña. Volvé a Planificar difusión.',409)
    return {existing,plan:null,hash}
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,138))',[user.user_id])
  const scheduled = data.scheduled_at ? new Date(data.scheduled_at) : undefined
  const window = broadcastPlanWindow(new Date(),request.options)
  if (scheduled && (scheduled < window.startsAt || scheduled >= window.endsAt))
    throw new BroadcastPlanError('La programación debe estar dentro del horario del plan. Volvé a Planificar difusión para cambiarlo.')
  const plan = await prepareDailyBroadcast(user,request.options,client,scheduled)
  const ids = plan.contacts.filter(c => !c.reason).map(c => c.id).sort()
  const submitted = [...new Set(data.contact_ids ?? [])].sort()
  if (plan.fingerprint !== request.fingerprint || JSON.stringify(ids) !== JSON.stringify(submitted))
    throw new BroadcastPlanChangedError(plan)
  if (!ids.length) throw new BroadcastPlanError('El plan no tiene contactos seleccionados. Volvé a calcularlo.',422)
  if (data.scheduled_at && (Date.parse(data.scheduled_at) < Date.parse(plan.startsAt) || Date.parse(data.scheduled_at) >= Date.parse(plan.endsAt)))
    throw new BroadcastPlanError('La programación debe estar dentro del horario del plan. Volvé a Planificar difusión para cambiarlo.')
  return {existing:null,plan,hash}
}

export async function persistCampaignBroadcast(client: PoolClient, campaignId: string, user: SessionUser, data: CreateCampaignInput, plan: BroadcastPlan, hash: string) {
  const contacts = plan.contacts.filter(c => !c.reason)
  const ids = contacts.map(c => c.id)
  const {rows:locked} = await client.query<{id:string;phone_number:string}>(
    'SELECT id,phone_number FROM contacts WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[ids])
  const expectedPhones = new Map(contacts.map(c => [c.id,c.phone]))
  if (locked.length !== ids.length || locked.some(c => expectedPhones.get(c.id) !== c.phone_number))
    throw new BroadcastPlanError('Cambió un teléfono mientras guardabas. Volvé a calcular el plan.',409)
  const assignments = Object.fromEntries(contacts.map(c => [c.phone.replace(/\D/g,''),c.lineId]))
  await client.query(`UPDATE campaigns SET broadcast_plan=$2::jsonb,audience_snapshot_at=NOW(),is_priority_broadcast=true WHERE id=$1`,
    [campaignId,JSON.stringify({version:1,requestHash:hash,options:data.broadcast_plan!.options,
      startsAt:plan.startsAt,endsAt:plan.endsAt,lines:plan.lines.filter(l => l.selected).map(({id,name,selected})=>({id,name,selected})),assignments})])
  await client.query('INSERT INTO campaign_audience_members(campaign_id,contact_id) SELECT $1,unnest($2::uuid[])',[campaignId,ids])
  await client.query(`INSERT INTO campaign_line_assignments AS a(owner_key,phone,line_id,source)
    SELECT $1,key,value::uuid,'rotation' FROM jsonb_each_text($2::jsonb)
    ON CONFLICT(owner_key,phone) DO UPDATE SET line_id=EXCLUDED.line_id,source=EXCLUDED.source,assigned_at=NOW() WHERE a.line_id IS NULL`,[user.user_id,JSON.stringify(assignments)])
  // Materialize the exact reviewed destinations now; later list edits cannot add recipients.
  await client.query(`INSERT INTO campaign_recipients(campaign_id,contact_id,phone_number,line_id,agent_code,created_at)
    SELECT $1,c.id,c.phone_number,($3::jsonb->>regexp_replace(c.phone_number,'[^0-9]','','g'))::uuid,contact_agent_key(c.panel),
      NOW()+(planned.rank-1)*interval '1 microsecond'
    FROM unnest($2::uuid[]) WITH ORDINALITY AS planned(contact_id,rank) JOIN contacts c ON c.id=planned.contact_id`,[campaignId,ids,JSON.stringify(assignments)])
  await client.query('INSERT INTO priority_broadcasts(campaign_id,request_hash,actor_name) VALUES($1,$2,$3)',[campaignId,hash,user.name||user.email||'Operador'])
}
