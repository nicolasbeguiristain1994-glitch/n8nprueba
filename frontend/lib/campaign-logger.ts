/**
 * Structured logger for campaign processor events.
 *
 * Outputs newline-delimited JSON to stdout/stderr so that log aggregators
 * (Datadog, Loki, CloudWatch, etc.) can parse and index structured fields.
 *
 * Usage:
 *   clog.info({ event: 'campaign.started', campaignId: id, mode: 'single-line' })
 *   clog.warn({ event: 'recipient.skipped', campaignId, recipientId, reason })
 *   clog.error({ event: 'processor.crashed', campaignId, error: e.message })
 *   clog.critical({ event: 'campaign.paused', campaignId, reason: 'systemic_error' })
 *
 * Severity contract:
 *   info     → normal operational events (start, send, complete)
 *   warn     → anomalies that don't stop the campaign (skipped, freq-blocked, partial fail)
 *   error    → failures that affect individual recipients or one cycle
 *   critical → events that require operator attention: campaign stopped, lock stale,
 *              config missing, consecutive systemic failures. Always logged to stderr
 *              with alert:true for trivial aggregator filtering (level="critical" OR alert=true).
 *
 * Alerting integration:
 *   critical events carry { alert: true } — use this field to route to PagerDuty/Slack:
 *     Datadog: log_level:critical OR @alert:true
 *     Loki:    {level="critical"}
 *     CloudWatch Logs Insights: filter alert = true
 *
 * Privacy: do NOT include full phone numbers, contact PIIs beyond last-4 digits, or
 * message bodies. Phone fragments (last 4 digits) are acceptable for debugging.
 */

export type CampaignMode = 'single-line' | 'multi-line'

export type CampaignLogPayload = {
  event:      string
  campaignId: string
  mode?:      CampaignMode
  [key: string]: unknown
}

type Level = 'info' | 'warn' | 'error' | 'critical'

function write(level: Level, payload: CampaignLogPayload): void {
  const alert = level === 'critical'
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    ...(alert ? { alert: true } : {}),
    ...payload,
  })
  // critical and error always go to stderr for easy filtering
  if (level === 'error' || level === 'critical') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const clog = {
  info:     (p: CampaignLogPayload) => write('info',     p),
  warn:     (p: CampaignLogPayload) => write('warn',     p),
  error:    (p: CampaignLogPayload) => write('error',    p),
  critical: (p: CampaignLogPayload) => write('critical', p),
}

/**
 * Returns true if a pause_reason warrants an operational alert.
 * Use to gate expensive alerting side-effects (webhook calls, etc.) if added later.
 */
export function isAlertablePauseReason(
  reason: string | null | undefined,
): boolean {
  return reason === 'systemic_error' || reason === 'config_missing'
}
