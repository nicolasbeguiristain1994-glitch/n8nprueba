import { processAutomationJobs } from '@/lib/automation-engine'
import { after, NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { claimDueCampaigns, isCampaignSchedulerEnabled, processScheduledCampaign, type ScheduledJob } from '@/lib/campaign-scheduler'

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return NextResponse.json({ error: 'CRON_SECRET no configurado' }, { status: 503 })
  const supplied = Buffer.from(req.headers.get('x-cron-secret') ?? '')
  const expected = Buffer.from(secret)
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const automationEnabled = process.env.AUTOMATION_SCHEDULER_ENABLED === 'true'
  if (!isCampaignSchedulerEnabled() && !automationEnabled) return NextResponse.json({ ok: true, enabled: false, claimed: 0 })
  try {
    // Register before any claim: an unavailable after context must leave no locks.
    let jobs: ScheduledJob[] = []
    after(async () => {
      await Promise.allSettled([...(automationEnabled ? [processAutomationJobs()] : []), ...jobs.map(job => processScheduledCampaign(job))])
    })
    const claims = await claimDueCampaigns()
    jobs = claims.jobs
    const { blocked } = claims
    // This acknowledges atomic claims, not delivery or completion of messages.
    return NextResponse.json({ ok: true, enabled: isCampaignSchedulerEnabled(), automationsEnabled: automationEnabled, claimed: jobs.length, blocked })
  } catch (error) {
    console.error('[campaign scheduler]', error instanceof Error ? error.message : 'claim failed')
    return NextResponse.json({ error: 'No se pudieron iniciar las campañas programadas' }, { status: 500 })
  }
}
