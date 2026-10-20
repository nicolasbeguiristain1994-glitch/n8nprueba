import { getDbClient, query } from '@/lib/db'
import { getLineVolumeInputs } from '@/lib/line-volume-data'
import { recommendLineVolume, LINE_VOLUME_TIME_ZONE, type LineVolumeInput } from '@/lib/line-volume-policy'

export type LineSendBudgetReservation = { id: string }
export class LineSendBudgetError extends Error {
  readonly code = 'LINE_SEND_BUDGET_WAIT'
  readonly status = 409
  constructor(readonly reason: string, readonly retryAt: string, readonly autoResume = false) {
    super('El envío queda pendiente hasta que la línea vuelva a tener capacidad segura.')
    this.name = 'LineSendBudgetError'
  }
}
export class LineSendAlreadyReservedError extends Error {
  readonly code = 'LINE_SEND_ALREADY_RESERVED'
  constructor() { super('Este intento ya tiene una reserva; no se puede reenviar.'); this.name = 'LineSendAlreadyReservedError' }
}

type LineBudgetRow = {
  id: string; respect_daily_recommendation: boolean; status: string; is_connected: boolean
  sending_enabled: boolean; allowed_types: string[] | null; msg_per_day: number; msg_per_hour: number
  msgs_sent_today: number; msgs_sent_hour: number; day_reset_at: Date | null; hour_reset_at: Date | null
  budget_date: string; next_day_at: Date; db_now: Date
}
const checkAgain = () => new Date(Date.now() + 180_000).toISOString()
// Preserve service capacity only when the optional campaign protection is enabled.
export const commercialCapacity = (limit: number) => limit > 1 ? limit - Math.max(1, Math.ceil(limit * 0.2)) : Math.max(0, limit)

/** All campaign/automation attempts reserve the rolling counters under one line lock.
 * Campaign policy/history is read before acquiring the lock: no nested pool checkout or HTTP in the transaction.
 * The durable daily ledger then covers concurrent reservations not yet present in message history.
 */
export async function reserveLineSendBudget(input: {
  lineId: string; purpose: 'campaign' | 'automation' | 'service'; sendKey: string
}): Promise<LineSendBudgetReservation> {
  let enabled = false
  try {
    if (!input.sendKey || input.sendKey.length > 300) throw new Error('invalid send key')
    const [settings] = await query<{ respect_daily_recommendation: boolean }>(
      'SELECT respect_daily_recommendation FROM whatsapp_lines WHERE id=$1', [input.lineId])
    enabled = !!settings?.respect_daily_recommendation && input.purpose === 'campaign'
    let evidence: LineVolumeInput | undefined
    if (enabled) {
      ;[evidence] = await getLineVolumeInputs([input.lineId])
      if (!evidence) throw new LineSendBudgetError('evidence_unavailable', checkAgain(), true)
    }
    const db = await getDbClient()
    try {
      await db.query('BEGIN')
      const { rows: [line] } = await db.query<LineBudgetRow>(`SELECT *,
        (NOW() AT TIME ZONE $2)::date::text AS budget_date,
        (((NOW() AT TIME ZONE $2)::date + 1)::timestamp AT TIME ZONE $2) AS next_day_at,
        NOW() AS db_now FROM whatsapp_lines WHERE id=$1 FOR UPDATE`, [input.lineId, LINE_VOLUME_TIME_ZONE])
      if (!line) throw new LineSendBudgetError('line_unavailable', checkAgain())
      enabled = !!line.respect_daily_recommendation && input.purpose === 'campaign'
      if (line.status !== 'active' || !line.is_connected || !line.sending_enabled ||
          (input.purpose === 'campaign' && line.allowed_types && !line.allowed_types.includes('campaign'))) {
        throw new LineSendBudgetError('line_unavailable', checkAgain(), enabled)
      }
      const { rows: [existing] } = await db.query<{ id: string; status: string; line_id: string; purpose: string }>(
        'SELECT id,status,line_id,purpose FROM line_send_budget_reservations WHERE send_key=$1 FOR UPDATE', [input.sendKey])
      if (existing && (existing.status !== 'released' || existing.line_id !== input.lineId || existing.purpose !== input.purpose)) {
        throw new LineSendAlreadyReservedError()
      }
      const now = new Date(line.db_now)
      const dayReset = line.day_reset_at && new Date(line.day_reset_at) > now ? new Date(line.day_reset_at) : new Date(now.getTime() + 86_400_000)
      const hourReset = line.hour_reset_at && new Date(line.hour_reset_at) > now ? new Date(line.hour_reset_at) : new Date(now.getTime() + 3_600_000)
      const dayUsed = line.day_reset_at && new Date(line.day_reset_at) <= now ? 0 : Math.max(0, Number(line.msgs_sent_today))
      const hourUsed = line.hour_reset_at && new Date(line.hour_reset_at) <= now ? 0 : Math.max(0, Number(line.msgs_sent_hour))
      const dailyCap = enabled ? commercialCapacity(Number(line.msg_per_day)) : Number(line.msg_per_day)
      const hourlyCap = enabled ? commercialCapacity(Number(line.msg_per_hour)) : Number(line.msg_per_hour)
      const waits: Date[] = []
      if (dayUsed >= dailyCap) waits.push(dayReset)
      if (hourUsed >= hourlyCap) waits.push(hourReset)
      let observed = 0
      let recommended: number | null = null
      if (enabled) {
        if (!evidence) throw new LineSendBudgetError('evidence_unavailable', checkAgain(), true)
        const policy = recommendLineVolume({ ...evidence, now: now.toISOString(), dailyUsed: dayUsed, hourlyUsed: hourUsed,
          dailyLimit: Number(line.msg_per_day), hourlyLimit: Number(line.msg_per_hour) })
        if (policy.date !== line.budget_date || policy.suggestedToday === null ||
            policy.status === 'stop' || policy.status === 'unavailable') {
          throw new LineSendBudgetError('recommendation_unavailable', checkAgain(), true)
        }
        observed = policy.attemptedToday
        recommended = policy.suggestedToday
      }
      if (input.purpose === 'campaign') {
        await db.query(`INSERT INTO line_campaign_daily_budgets(line_id,budget_date,consumed)
          VALUES($1,$2,$3) ON CONFLICT(line_id,budget_date) DO UPDATE
          SET consumed=GREATEST(line_campaign_daily_budgets.consumed,EXCLUDED.consumed),updated_at=NOW()`,
        [input.lineId, line.budget_date, observed])
        const { rows: [budget] } = await db.query<{ consumed: number }>(
          'SELECT consumed FROM line_campaign_daily_budgets WHERE line_id=$1 AND budget_date=$2 FOR UPDATE', [input.lineId, line.budget_date])
        if (recommended !== null && Number(budget.consumed) >= recommended) waits.push(new Date(line.next_day_at))
      }
      if (waits.length) throw new LineSendBudgetError('capacity_exhausted', new Date(Math.max(...waits.map(d => d.getTime()))).toISOString(), enabled)
      await db.query(`UPDATE whatsapp_lines SET msgs_sent_today=$2+1,msgs_sent_hour=$3+1,
        day_reset_at=$4,hour_reset_at=$5,updated_at=NOW() WHERE id=$1`, [input.lineId,dayUsed,hourUsed,dayReset,hourReset])
      if (input.purpose === 'campaign') await db.query(`UPDATE line_campaign_daily_budgets
        SET consumed=consumed+1,updated_at=NOW() WHERE line_id=$1 AND budget_date=$2`, [input.lineId,line.budget_date])
      const { rows: [reservation] } = await db.query<LineSendBudgetReservation>(`INSERT INTO line_send_budget_reservations
        (line_id,send_key,purpose,budget_date,day_reset_at,hour_reset_at) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(send_key) DO UPDATE SET status='reserved',budget_date=EXCLUDED.budget_date,
          day_reset_at=EXCLUDED.day_reset_at,hour_reset_at=EXCLUDED.hour_reset_at,updated_at=NOW()
        WHERE line_send_budget_reservations.status='released' RETURNING id`,
      [input.lineId,input.sendKey,input.purpose,line.budget_date,dayReset,hourReset])
      if (!reservation) throw new LineSendAlreadyReservedError()
      await db.query('COMMIT')
      return reservation
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {})
      throw error
    } finally { db.release() }
  } catch (error) {
    if (error instanceof LineSendBudgetError || error instanceof LineSendAlreadyReservedError) throw error
    throw new LineSendBudgetError('budget_check_unavailable', checkAgain(), enabled)
  }
}

/** Refund only definite no-send, and only the windows originally charged. A consumed or
 * interrupted attempt stays charged; retries must use a fresh durable attempt identity. */
export async function finishLineSendBudget(id: string, outcome: 'consumed' | 'no_send'): Promise<void> {
  const db = await getDbClient()
  try {
    await db.query('BEGIN')
    // Same lock order as reserve prevents reservation/line deadlocks.
    const { rows: [ref] } = await db.query<{ line_id: string }>('SELECT line_id FROM line_send_budget_reservations WHERE id=$1', [id])
    if (!ref) throw new Error('Unknown line budget reservation')
    await db.query('SELECT id FROM whatsapp_lines WHERE id=$1 FOR UPDATE', [ref.line_id])
    const { rows: [reservation] } = await db.query<{ line_id: string; purpose: string; budget_date: string; day_reset_at: Date; hour_reset_at: Date }>(
      `UPDATE line_send_budget_reservations SET status=$2,updated_at=NOW() WHERE id=$1 AND status='reserved'
        RETURNING line_id,purpose,budget_date,day_reset_at,hour_reset_at`, [id,outcome === 'consumed' ? 'consumed' : 'released'])
    if (reservation && outcome === 'no_send') {
      await db.query(`UPDATE whatsapp_lines SET
        msgs_sent_today=CASE WHEN day_reset_at=$2 THEN GREATEST(msgs_sent_today-1,0) ELSE msgs_sent_today END,
        msgs_sent_hour=CASE WHEN hour_reset_at=$3 THEN GREATEST(msgs_sent_hour-1,0) ELSE msgs_sent_hour END,
        updated_at=NOW() WHERE id=$1`, [reservation.line_id,reservation.day_reset_at,reservation.hour_reset_at])
      if (reservation.purpose === 'campaign') await db.query(`UPDATE line_campaign_daily_budgets
        SET consumed=GREATEST(consumed-1,0),updated_at=NOW() WHERE line_id=$1 AND budget_date=$2`, [reservation.line_id,reservation.budget_date])
    }
    await db.query('COMMIT')
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error } finally { db.release() }
}

export async function deferCampaignForLineBudget(campaignId: string, error: LineSendBudgetError): Promise<void> {
  // Never convert a manual/risk pause or start a stopped campaign. Only opt-in lines may auto-resume.
  await query(`UPDATE campaigns SET status='paused',pause_reason=$2,budget_resume_at=$3,updated_at=NOW()
    WHERE id=$1 AND status='running' AND pause_reason IS DISTINCT FROM 'risk_detected'`,
  [campaignId,error.autoResume ? 'line_budget' : 'no_eligible_lines',error.autoResume ? error.retryAt : null])
}
