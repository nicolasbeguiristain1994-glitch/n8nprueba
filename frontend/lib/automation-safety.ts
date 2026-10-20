import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { query, withTransaction } from '@/lib/db'
import { resolveConsentIdentity } from '@/lib/consent-context'

export const AUTOMATION_MAX_REPLIES = 3
export const AUTOMATION_MIN_GAP_SECONDS = 10
export type AutomationSafetyContext = { phone: string; provider: 'cloud'|'evolution'; source_id: string; agent_code: string|null }
export type AutomationSafetyJob = AutomationSafetyContext & { id: string; event_key: string; body: string; created_at?: string|Date }
type Prior = { id: string; body: string; body_fingerprint: string|null; link_fingerprints: string[]; status: string; created_at: string|Date }
type SafetyState = { last_human_at: string|Date|null; last_automation_at: string|Date|null; handoff_event_key: string|null; now: string|Date }
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
export const automationScope = (context: AutomationSafetyContext) => context.agent_code ? `agent:${context.agent_code}` : `${context.provider}:${context.source_id}`

/** Ignore formatting and tracking-only URL changes; never store a second copy of message content. */
export function automationFingerprints(body: string): { body: string; links: string[] } {
  const links = new Set<string>()
  for (const raw of body.match(/(?:https?:\/\/|www\.)[^\s<>]+/gi) ?? []) {
    try {
      const url = new URL(raw.replace(/[),.!?;:]+$/, '').replace(/^www\./i, 'https://www.'))
      url.hash = ''
      for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key)
      url.searchParams.sort()
      links.add(hash(`${url.origin}${url.pathname.replace(/\/$/,'')}${url.search}`))
    } catch { /* An invalid URL is still covered by the body fingerprint. */ }
  }
  return { body: hash(body.normalize('NFKC').toLocaleLowerCase('es').replace(/\s+/g,' ').trim()), links: [...links].sort() }
}

export async function lockAutomationConversation(db: PoolClient, context: AutomationSafetyContext): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`automation-safety:${automationScope(context)}:${context.phone}`])
}
async function safetyState(db: PoolClient, context: AutomationSafetyContext): Promise<SafetyState> {
  const { rows } = await db.query<SafetyState>(`SELECT s.last_human_at,s.last_automation_at,s.handoff_event_key,clock_timestamp() AS now
    FROM (VALUES(1)) seed(n) LEFT JOIN automation_conversation_safety s ON s.phone=$1 AND s.scope_key=$2`, [context.phone,automationScope(context)])
  return rows[0]
}
const scopeSql = `(agent_code IS NOT DISTINCT FROM $2 AND ($2::text IS NOT NULL OR (provider=$3 AND source_id=$4)))`
async function recentJobs(db: PoolClient, context: AutomationSafetyContext, current?: AutomationSafetyJob): Promise<Prior[]> {
  // A pending job reserves capacity, including across different lines of the same agent.
  // At dispatch only older pending jobs outrank this job; accepted/uncertain attempts always count.
  const { rows } = await db.query<Prior>(`SELECT id,body,body_fingerprint,link_fingerprints,status,created_at
    FROM automation_message_jobs WHERE phone=$1 AND ${scopeSql} AND status<>'skipped'
      AND GREATEST(created_at,COALESCE(started_at,created_at))>clock_timestamp()-interval '24 hours'
      AND ($5::uuid IS NULL OR (id<>$5 AND (status IN ('sent','uncertain','failed') OR
        (created_at,id)<(SELECT created_at,id FROM automation_message_jobs WHERE id=$5))))
    ORDER BY created_at,id LIMIT 100`, [context.phone,context.agent_code,context.provider,context.source_id,current?.id??null])
  return rows
}
function repeated(body: string, previous: Prior[]): boolean {
  const fingerprint = automationFingerprints(body)
  return previous.some(p => {
    const old = p.body_fingerprint ? { body: p.body_fingerprint, links: p.link_fingerprints ?? [] } : automationFingerprints(p.body)
    return old.body === fingerprint.body || fingerprint.links.some(link => old.links.includes(link))
  })
}
const humanRecent = (state: SafetyState) => state.last_human_at != null && new Date(state.now).getTime()-new Date(state.last_human_at).getTime()<86_400_000

/** Caller holds the same conversation lock used by dispatch and human intervention. */
export async function automationAdmission(db: PoolClient, context: AutomationSafetyContext, body: string): Promise<string|null> {
  if (humanRecent(await safetyState(db,context))) return 'Un asesor intervino en las últimas 24 horas'
  const previous = await recentJobs(db,context)
  if (previous.length >= AUTOMATION_MAX_REPLIES) return 'Máximo de 3 respuestas automáticas en 24 horas alcanzado'
  if (repeated(body,previous)) return 'El mismo mensaje o enlace ya fue enviado o reservado en estas 24 horas'
  return null
}

export async function setAutomationHandoff(db: PoolClient, context: AutomationSafetyContext, eventKey: string): Promise<void> {
  await db.query(`INSERT INTO automation_conversation_safety(phone,scope_key,handoff_event_key)
    VALUES($1,$2,$3) ON CONFLICT(phone,scope_key) DO UPDATE SET handoff_event_key=$3,updated_at=clock_timestamp()`,
  [context.phone,automationScope(context),eventKey])
}

/** Called after authorization/content checks and before an advisor's provider request. */
export async function recordHumanAutomationIntervention(phone: string, source: { provider: 'cloud'|'evolution'; sourceId: string }, observedAt = new Date()): Promise<string|null> {
  const number = phone.replace(/\D/g,'')
  if (!number || !source.sourceId || !Number.isFinite(observedAt.getTime()) || observedAt.getTime()<Date.now()-86_400_000) return null
  const humanAt=new Date(Math.min(observedAt.getTime(),Date.now())).toISOString()
  const identity = await resolveConsentIdentity(number,source)
  const context = { phone: number,provider: source.provider,source_id: source.sourceId,agent_code: identity.agent }
  await withTransaction(async db => {
    await lockAutomationConversation(db,context)
    await db.query(`INSERT INTO automation_conversation_safety(phone,scope_key,last_human_at,handoff_event_key)
      VALUES($1,$2,$3,NULL) ON CONFLICT(phone,scope_key) DO UPDATE SET
      last_human_at=GREATEST(automation_conversation_safety.last_human_at,$3::timestamptz),handoff_event_key=NULL,updated_at=clock_timestamp()`, [number,automationScope(context),humanAt])
    await db.query(`UPDATE automation_message_jobs SET status='skipped',finished_at=clock_timestamp(),
      details='Un asesor intervino; automatización suspendida por 24 horas'
      WHERE phone=$1 AND ${scopeSql} AND (status='queued' OR (status='processing' AND dispatch_authorized_at IS NULL))`, [number,identity.agent,source.provider,source.sourceId])
  })
  return identity.agent
}

export async function recordAutomationDispatchFinished(db:PoolClient,job:AutomationSafetyJob):Promise<void> {
  await db.query(`UPDATE automation_conversation_safety SET last_automation_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE phone=$1 AND scope_key=$2`,[job.phone,automationScope(job)])
}

export type AutomationDispatchResult<T> = { kind: 'dispatched'; value: T } | { kind: 'skipped'; detail: string } | { kind: 'deferred' }
/** Commit a durable authorization before external I/O; never hold a connection while the provider runs.
 * Human intervention cancels jobs before this fence. An already authorized request may be in flight.
 */
export async function withAutomationSafety<T>(job: AutomationSafetyJob, send: () => Promise<T>): Promise<AutomationDispatchResult<T>> {
  const admission: AutomationDispatchResult<T>|null = await withTransaction(async db => {
    await lockAutomationConversation(db,job)
    const current = await db.query(`SELECT 1 FROM automation_message_jobs WHERE id=$1 AND status='processing'`, [job.id])
    if (!current.rows.length) return { kind: 'skipped',detail: 'El paso ya fue cancelado' }
    const state = await safetyState(db,job)
    if (humanRecent(state)) return { kind: 'skipped',detail: 'Un asesor intervino en las últimas 24 horas' }
    const escalated = await db.query(`SELECT 1 FROM conversation_state WHERE regexp_replace(phone_number,'[^0-9]','','g')=$1
      AND resolved_at IS NULL AND is_escalated=true LIMIT 1`, [job.phone])
    if (escalated.rows.length && state.handoff_event_key !== job.event_key)
      return { kind: 'skipped',detail: 'La conversación fue derivada a un asesor' }
    // Every job belongs to a real inbound event. A later inbound cannot revive an expired flow.
    const inbound = await db.query(`SELECT 1 FROM automation_inbound_receipts WHERE event_key=$1 AND phone=$2
      AND provider=$3 AND source_id=$4 AND created_at>clock_timestamp()-interval '24 hours'`, [job.event_key,job.phone,job.provider,job.source_id])
    if (!inbound.rows.length) return { kind: 'skipped',detail: 'La sesión de 24 horas del mensaje que inició el flujo terminó' }
    const previous = await recentJobs(db,job,job)
    if (previous.length >= AUTOMATION_MAX_REPLIES) return { kind: 'skipped',detail: 'Máximo de 3 respuestas automáticas en 24 horas alcanzado' }
    if (repeated(job.body,previous)) return { kind: 'skipped',detail: 'El mismo mensaje o enlace ya fue enviado o reservado en estas 24 horas' }
    const busy=await db.query(`SELECT 1 FROM automation_message_jobs WHERE phone=$1 AND ${scopeSql}
      AND id<>$5 AND status='processing' AND dispatch_authorized_at IS NOT NULL LIMIT 1`,
      [job.phone,job.agent_code,job.provider,job.source_id,job.id])
    if(busy.rows.length) {
      await db.query(`UPDATE automation_message_jobs SET status='queued',started_at=NULL,dispatch_authorized_at=NULL,
        run_at=GREATEST(run_at,clock_timestamp()+interval '10 seconds') WHERE id=$1 AND status='processing'`,[job.id])
      return {kind:'deferred'}
    }
    if (state.last_automation_at && new Date(state.now).getTime()-new Date(state.last_automation_at).getTime()<AUTOMATION_MIN_GAP_SECONDS*1000) {
      await db.query(`UPDATE automation_message_jobs SET status='queued',started_at=NULL,dispatch_authorized_at=NULL,
        run_at=GREATEST(run_at,$2::timestamptz+interval '10 seconds') WHERE id=$1 AND status='processing'`, [job.id,state.last_automation_at])
      return { kind: 'deferred' }
    }
    await db.query(`INSERT INTO automation_conversation_safety(phone,scope_key,last_automation_at)
      VALUES($1,$2,clock_timestamp()) ON CONFLICT(phone,scope_key) DO UPDATE SET last_automation_at=clock_timestamp(),updated_at=clock_timestamp()`,
    [job.phone,automationScope(job)])
    await db.query(`UPDATE automation_message_jobs SET dispatch_authorized_at=clock_timestamp() WHERE id=$1 AND status='processing'`,[job.id])
    return null
  })
  if(admission) return admission
  return {kind:'dispatched',value:await send()}
}

/** A last check after capacity reservation catches human intervention during local preparation. */
export async function automationDispatchStillAllowed(job:AutomationSafetyJob):Promise<boolean> {
  const rows=await query(`SELECT 1 FROM automation_message_jobs j LEFT JOIN automation_conversation_safety s
    ON s.phone=j.phone AND s.scope_key=$2 WHERE j.id=$1 AND j.status='processing' AND j.dispatch_authorized_at IS NOT NULL
    AND (s.last_human_at IS NULL OR s.last_human_at<=clock_timestamp()-interval '24 hours')`,[job.id,automationScope(job)])
  return rows.length>0
}
