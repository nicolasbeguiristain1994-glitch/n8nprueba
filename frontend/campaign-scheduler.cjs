'use strict'

// Importing this module creates no timers or requests. The application entrypoint
// must call startCampaignScheduler explicitly after deciding whether to enable it.
function startCampaignScheduler({ port = process.env.PORT || 3000, env = process.env,
  fetchImpl = globalThis.fetch, logger = console, initialDelayMs = 45000,
  intervalMs = 60000, timeoutMs = 15000 } = {}) {
  let stopped = false, busy = false, initial, interval
  const validPort = /^\d+$/.test(String(port)) && Number(port) > 0 && Number(port) <= 65535
  const enabled = () => !stopped && (env.CAMPAIGN_SCHEDULER_ENABLED === 'true' || env.AUTOMATION_SCHEDULER_ENABLED === 'true') && !!env.CRON_SECRET && validPort
  async function tick() {
    if (!enabled() || busy) return
    busy = true
    try {
      const response = await fetchImpl(`http://127.0.0.1:${Number(port)}/api/cron/campaigns`, {
        method: 'POST', headers: { 'x-cron-secret': env.CRON_SECRET },
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      })
      // Consume the short local JSON response without logging bodies or secrets.
      await response.arrayBuffer()
      if (!response.ok) logger.warn(`[campaign scheduler] HTTP ${response.status}`)
    } catch {
      logger.warn('[campaign scheduler] solicitud local fallida o vencida')
    } finally { busy = false }
  }
  if (enabled()) {
    initial = setTimeout(() => {
      void tick()
      interval = setInterval(() => { void tick() }, intervalMs)
      interval.unref?.()
    }, initialDelayMs)
    initial.unref?.()
  }
  return { tick, stop() { stopped = true; clearTimeout(initial); clearInterval(interval) } }
}

module.exports = { startCampaignScheduler }
