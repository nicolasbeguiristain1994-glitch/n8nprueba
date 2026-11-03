import type { PoolClient } from 'pg'
import type { SessionUser } from './auth'
import { withTransaction } from './db'
import { distributorVisibilityClause } from './line-visibility'
import { getLineVolumeInputs } from './line-volume-data'
import { recommendLineVolume } from './line-volume-policy'
import { segmentationSQL } from './contact-segmentation'
import { recentPriorityOrderSQL } from './user-prioritization/priority-details'
import { priorityAccess } from './user-prioritization/access'
import { FAILED_RESERVATION_SQL } from './campaign-retry'
import { ROUTING_SYSTEM_OWNER, campaignRoutingHistorySQL } from './campaign-routing'
import { ContactFrequencyRulesRepository } from './contact-frequency/repositories/ContactFrequencyRulesRepository'
import { resolveApplicableRule } from './contact-frequency/rules'
import { getAll as getScoringConfig } from './scoring-config-service'
import { getAllTiers } from './segmentation-config-service'
import { INACTIVITY_WINDOWS, RECONTACT_COOLDOWN_DAYS, DEPOSIT_AMOUNT_TIERS } from './user-prioritization/config'
import { buildBroadcastPlan, broadcastPlanWindow, broadcastPlanningDays, type PlanningContact, type PlanningLine, type BroadcastPlanOptions } from './broadcast-planner'

export class BroadcastPlanError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}
export interface PlanningTemplate { id: string; name: string; wabaId: string }
export interface BroadcastPlanningOptions {
  days: {date:string;label:string}[]
  lines: { id: string; name: string; type: string }[]
  templates: PlanningTemplate[]
}
const iso = (value: Date | string | null) => value ? new Date(value).toISOString() : null

async function readLines(client: PoolClient, user: SessionUser, endsAt: Date): Promise<PlanningLine[]> {
  // Use dispatch visibility: recommendations must be usable by this campaign owner.
  const scope = distributorVisibilityClause(user.user_id, 1, 'wl')
  const { rows } = await client.query(`SELECT wl.id, COALESCE(wl.display_name,wl.line_key) AS name,
    wl.line_type AS type,wl.status,wl.is_connected AS connected,wl.sending_enabled AS enabled,
    (wl.allowed_types IS NULL OR wl.allowed_types @> '["campaign"]'::jsonb) AS "campaignAllowed",
    wl.msg_per_day AS "dailyLimit",wl.msg_per_hour AS "hourlyLimit",
    wl.msgs_sent_today AS "sentToday",wl.msgs_sent_hour AS "sentHour",
    wl.day_reset_at AS "dayResetAt",wl.hour_reset_at AS "hourResetAt",wl.priority,
    cn.waba_id AS "wabaId",cn.token_expires_at AS "tokenExpiresAt",wl.personality_config,
    (cn.id IS NOT NULL AND (COALESCE(octet_length(cn.access_token_enc),0)>0 OR NULLIF(trim(cn.access_token),'') IS NOT NULL)
      AND (cn.token_expires_at IS NULL OR cn.token_expires_at>NOW())) AS "cloudReady"
    FROM whatsapp_lines wl LEFT JOIN cloud_numbers cn ON cn.whatsapp_line_id=wl.id AND cn.status='active'
    WHERE 1=1 ${scope.clause} ORDER BY wl.priority,wl.id`, scope.params)
  const ids = rows.map(r => r.id)
  const { rows: commitments } = await client.query(`
    SELECT COALESCE(cr.line_id,a.line_id) AS line_id, COUNT(*)::int AS n
    FROM campaign_recipients cr JOIN campaigns c ON c.id=cr.campaign_id
    LEFT JOIN campaign_line_assignments a ON a.owner_key=COALESCE(c.owned_by,'${ROUTING_SYSTEM_OWNER}'::uuid)
      AND a.phone=regexp_replace(cr.phone_number,'[^0-9]','','g')
    WHERE cr.status IN ('pending','sending') AND c.status IN ('draft','scheduled','running','paused')
      AND (c.scheduled_at IS NULL OR c.scheduled_at<$2)
      AND COALESCE(cr.line_id,a.line_id)=ANY($1::uuid[])
    GROUP BY COALESCE(cr.line_id,a.line_id)`, [ids, endsAt])
  const committed = new Map(commitments.map(r => [r.line_id, Number(r.n)]))
  return rows.map(row => {
    const config = row.personality_config
    const hours = config?.activeHours
    const valid = Array.isArray(hours) && hours.length === 2 && hours.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 24) && hours[0] !== hours[1]
    return { ...row, committed: committed.get(row.id) ?? 0,
      tokenExpiresAt:iso(row.tokenExpiresAt), dayResetAt: iso(row.dayResetAt), hourResetAt: iso(row.hourResetAt),
      activeHours: valid ? hours : null, timezoneOffset: Number(config?.timezoneOffsetHours ?? -3),
      invalidSchedule: row.type === 'evolution' && config != null && (!valid || !Number.isFinite(Number(config.timezoneOffsetHours ?? -3))),
    } as PlanningLine
  })
}

async function readTemplates(client: PoolClient, lines: PlanningLine[]): Promise<PlanningTemplate[]> {
  const { rows } = await client.query<PlanningTemplate>(`SELECT id,name,waba_id AS "wabaId" FROM whatsapp_templates
    WHERE status='APROBADA' AND NULLIF(trim(whatsapp_template_id),'') IS NOT NULL
      AND waba_id=ANY($1::text[]) ORDER BY name,id`, [[...new Set(lines.flatMap(l => l.wabaId ? [l.wabaId] : []))]])
  return rows
}

export async function getBroadcastPlanningOptions(user: SessionUser): Promise<BroadcastPlanningOptions> {
  return withTransaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    const now = new Date()
    const lines = await readLines(client,user,broadcastPlanWindow(now,{endTime:'23:59'}).endsAt)
    const templates = await readTemplates(client,lines)
    return { days:broadcastPlanningDays(now), lines: lines.map(({id,name,type}) => ({id,name,type})), templates }
  })
}

/** Read-only snapshot. No recipient, frequency slot, line assignment or counter is written. */
export async function prepareDailyBroadcast(user: SessionUser, options: BroadcastPlanOptions) {
  const [tiers, scoring] = await Promise.all([getAllTiers(),getScoringConfig()])
  return withTransaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    const { rows: [clock] } = await client.query<{ now: Date }>('SELECT NOW() AS now')
    const now = new Date(clock.now)
    const window = broadcastPlanWindow(now,options)
    if (!broadcastPlanningDays(now).some(day => day.date === window.date))
      throw new BroadcastPlanError('Elegí hoy, mañana o pasado mañana. Si cambió el día, cerrá y volvé a abrir el planificador.')
    if ((options.startTime ?? '09:00') >= options.endTime)
      throw new BroadcastPlanError('La hora de cierre debe ser posterior a la hora de inicio.')
    const lines = await readLines(client,user,window.endsAt)
    if (options.lineIds.some(id => !lines.some(l => l.id === id)))
      throw new BroadcastPlanError('Una de las líneas seleccionadas ya no está disponible para tu usuario.',403)
    const volumeInputs = await getLineVolumeInputs(lines.map(l => l.id),now,async <T>(sql: string,params?: unknown[]) => (await client.query(sql,params)).rows as T[])
    const volumes = new Map(volumeInputs.map(input => [input.id,recommendLineVolume(input)]))
    for (const line of lines) {
      const recommendation = volumes.get(line.id)
      line.recommendedDaily = recommendation?.suggestedToday ?? 0
      line.recommendedRemaining = recommendation?.remainingToday ?? 0
      line.recommendation = recommendation?.reason ?? 'No se pudo verificar la recomendación de volumen de esta línea.'
      line.volumeBlocked = !recommendation || ['stop','unavailable'].includes(recommendation.status)
    }
    const templates = options.messageType === 'template' ? await readTemplates(client,lines) : []
    const template = templates.find(t => t.id === options.templateId)
    if (options.messageType === 'template' && !template)
      throw new BroadcastPlanError('Seleccioná una plantilla aprobada y accesible.')
    const { rows: [job] } = await client.query(`SELECT last_complete_run_id,last_success_at,is_running
      FROM system_jobs WHERE job_name='prioritization_recompute'`)
    if (!job?.last_complete_run_id) throw new BroadcastPlanError('Primero ejecutá un cálculo completo de Prioridades.',409)

    const params: unknown[] = [job.last_complete_run_id]
    const conditions = ['cps.run_id=$1','cps.is_eligible=true','cps.is_broadcasted=false']
    for (const [key,column] of Object.entries({ platform: 'c.platforms',agent:'c.panel',valueTier:segmentationSQL('c').segment,reactivationSegment:'cps.reactivation_segment' })) {
      const value = options[key as keyof BroadcastPlanOptions]
      if (!value) continue
      params.push(value)
      conditions.push(key === 'platform' ? `$${params.length}=ANY(${column})` : `${column}=$${params.length}`)
    }
    const access = priorityAccess({ role:user.role,userId:user.user_id,allowedAgents:user.allowed_agents },params.length)
    params.push(...access.params)
    const { rows: candidates } = await client.query(`SELECT c.id,concat_ws(' ',c.first_name,c.last_name) AS name,
      c.phone_number AS phone,cps.priority_score AS score,cps.reactivation_segment AS segment,${segmentationSQL('c').segment} AS tier,
      c.panel AS agent,c.status,c.opt_in_marketing AS "optedIn",c.do_not_contact AS "doNotContact",
      (c.deleted_at IS NOT NULL) AS deleted,CASE WHEN c.segmentation_profile IS NOT NULL THEN ((c.segmentation_profile->>'last_date')::date::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires') ELSE c.last_deposit_at END AS "lastDepositAt",cps.computed_at AS "computedAt",
      EXISTS(SELECT 1 FROM blacklist b WHERE b.phone_number_normalized IN (c.phone_number,regexp_replace(c.phone_number,'[^0-9]','','g'))
        AND (b.scope_key='global' OR b.agent_code=contact_agent_key(c.panel)) AND b.removed_at IS NULL) AS blacklisted
      FROM contact_priority_scores cps JOIN contacts c ON c.id=cps.contact_id
      WHERE ${conditions.join(' AND ')} ${access.sql}
      ORDER BY cps.priority_score DESC, ${recentPriorityOrderSQL('c')}, cps.reactivation_segment,c.id LIMIT 10001`,params)
    if (candidates.length > 10000) throw new BroadcastPlanError('La audiencia supera los 10.000 contactos. Acotá los filtros de plataforma, agente o segmento.',422)
    const ids = candidates.map(c => c.id)
    const phones = [...new Set(candidates.map(c => (c.phone ?? '').replace(/\D/g,'')))]
    // Batch-load live contact pressure. Released/confirmed failures match the send engine.
    const { rows: history } = await client.query(`SELECT h.contact_id,
      COUNT(*) FILTER(WHERE sent_at>=$2::timestamptz-interval '24 hours')::int AS today,
      COUNT(*) FILTER(WHERE sent_at>=$2::timestamptz-interval '7 days')::int AS week,MAX(sent_at) AS last_sent_at
      FROM contact_send_history h WHERE h.contact_id=ANY($1::uuid[])
        AND h.frequency_released_at IS NULL AND NOT (${FAILED_RESERVATION_SQL}) GROUP BY h.contact_id`,[ids,window.startsAt])
    const { rows: queued } = await client.query(`SELECT DISTINCT regexp_replace(cr.phone_number,'[^0-9]','','g') AS phone
      FROM campaign_recipients cr JOIN campaigns c ON c.id=cr.campaign_id
      WHERE cr.status IN ('pending','sending') AND c.status IN ('draft','scheduled','running','paused')
        AND regexp_replace(cr.phone_number,'[^0-9]','','g')=ANY($1::text[])`,[phones])
    // Use the sender recovery rules from dispatch, without creating assignments.
    const { rows: assignments } = await client.query(`WITH missing AS (SELECT unnest($1::text[]) AS phone),
      ${campaignRoutingHistorySQL('$2', '$2')},
      latest AS (SELECT DISTINCT ON(phone) phone,line_id FROM history ORDER BY phone,at DESC NULLS LAST,line_id)
      SELECT p.phone,COALESCE(a.line_id,l.line_id) AS line_id,
        (COALESCE(a.line_id,l.line_id) IS NOT NULL) AS assigned
      FROM missing p LEFT JOIN campaign_line_assignments a ON a.owner_key=$2 AND a.phone=p.phone
      LEFT JOIN latest l ON l.phone=p.phone`,[phones,user.user_id])
    const historyMap = new Map(history.map(h => [h.contact_id,h]))
    const assignmentMap = new Map(assignments.map(a => [a.phone,a]))
    const queuedPhones = new Set(queued.map(q => q.phone))
    const contacts: PlanningContact[] = candidates.map(c => {
      const phone = (c.phone ?? '').replace(/\D/g,'')
      const h = historyMap.get(c.id), a = assignmentMap.get(phone)
      return { ...c, phone:c.phone ?? '',score:Number(c.score),
        lastDepositAt:iso(c.lastDepositAt),computedAt:iso(c.computedAt)!,lastSentAt:iso(h?.last_sent_at),
        sentToday:h?.today ?? 0,sentWeek:h?.week ?? 0,alreadyQueued:queuedPhones.has(phone),
        hasAssignment:a?.assigned ?? false,assignedLineId:a?.line_id ?? null } as PlanningContact
    })
    const rules = await new ContactFrequencyRulesRepository().findActiveRulesForContext(user.user_id,client)
    const inactivityWindows = { ...INACTIVITY_WINDOWS }, recontactCooldownDays = { ...RECONTACT_COOLDOWN_DAYS }
    for (const t of tiers) {
      inactivityWindows[t.tier] = {minDays:t.min_days_inactive,maxDays:t.max_days_inactive}
      recontactCooldownDays[t.tier] = t.recontact_cooldown_days
    }
    return buildBroadcastPlan({ contacts,lines,options,now,computedAt:iso(job.last_success_at),templateWaba:template?.wabaId ?? null,
      frequencyRule:resolveApplicableRule(rules,user.user_id,null,null),
      scorerConfig:{allowThreshold:scoring.allow_threshold,delayThreshold:scoring.delay_threshold,
        cooldownMultiplier:scoring.cooldown_multiplier,weights:{daily:scoring.risk_weight_daily,weekly:scoring.risk_weight_weekly,cooldown:scoring.risk_weight_cooldown}},
      eligibilityConfig:{inactivityWindows,recontactCooldownDays,depositAmountTiers:DEPOSIT_AMOUNT_TIERS,enabledTiers:tiers.map(t => t.tier)},
      warnings:[...(job.is_running ? ['Prioridades se está actualizando; este plan usa el último cálculo completo.'] : []),
        'Vista previa: no reserva cupos ni crea campañas. La disponibilidad se debe volver a verificar al enviar.',
        'Se descuentan pendientes con línea asignada anteriores al cierre elegido. Campañas todavía sin asignación pueden reducir la capacidad disponible.',
        'El cupo también respeta el volumen recomendado según historial y calidad de cada línea.',
        'La capacidad es una estimación por horario y límites locales; no verifica cuotas del proveedor en tiempo real.'],
    })
  })
}
