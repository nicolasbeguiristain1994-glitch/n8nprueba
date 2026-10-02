// Next invokes this hook for both next start and the standalone server.js entry.
// Importing the module itself is inert, including during compilation.
type SchedulerGlobal = typeof globalThis & { __campaignSchedulerRegistration?: Promise<void> }

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NODE_ENV !== 'production' ||
      process.env.NEXT_PHASE === 'phase-production-build' ||
      (process.env.CAMPAIGN_SCHEDULER_ENABLED !== 'true' && process.env.AUTOMATION_SCHEDULER_ENABLED !== 'true') || !process.env.CRON_SECRET) return

  const runtime = globalThis as SchedulerGlobal
  // Store the pending import before awaiting it, preventing concurrent register
  // calls or module reloads from installing more than one timer per process.
  if (!runtime.__campaignSchedulerRegistration) {
    runtime.__campaignSchedulerRegistration = import('./campaign-scheduler.cjs')
      .then(({ startCampaignScheduler }) => { startCampaignScheduler() })
      .catch(error => {
        delete runtime.__campaignSchedulerRegistration
        throw error
      })
  }
  await runtime.__campaignSchedulerRegistration
}
