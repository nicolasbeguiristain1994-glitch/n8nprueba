import { randomUUID } from 'node:crypto'
import { query, withTransaction } from '@/lib/db'
import { canAccess } from '@/lib/permissions'
import {
  createDispatchUnits, createDispatchUnitsFromProspectList,
  processMultiLineInBackground, type CampaignForDispatch,
} from '@/lib/campaign-distributor'
import { processInBackground, type CampaignRow } from '@/lib/send-processor'
import { clog } from '@/lib/campaign-logger'

type ScheduledCampaign = CampaignForDispatch & {
  prospect_list_id: string | null; use_multi_line: boolean; scheduled_at: string
}
type Owner = { role: 'admin' | 'operator' | 'viewer'; sectors: string[]; is_active: boolean }
export type ScheduledJob = { campaign: ScheduledCampaign; lockToken: string }
export const isCampaignSchedulerEnabled = () => process.env.CAMPAIGN_SCHEDULER_ENABLED === 'true'
function maySend(owner: Owner | undefined) {
  return !!owner?.is_active && canAccess(owner, 'campaigns', 'update') && canAccess(owner, 'send', 'send')
}

// Only scheduled, due, unlocked campaigns are eligible. The claim is its own
// conditional transition; the manual resume lock deliberately is not reused.
export async function claimDueCampaigns(): Promise<{ jobs: ScheduledJob[]; blocked: number }> {
  if (!isCampaignSchedulerEnabled()) return { jobs: [], blocked: 0 }
  return withTransaction(async client => {
    const { rows: campaigns } = await client.query<ScheduledCampaign>(
      `SELECT c.*, wt.name AS template_name, wt.language AS template_language,
              wt.waba_id AS template_waba_id, wt.status AS template_status
       FROM campaigns c LEFT JOIN whatsapp_templates wt ON wt.id = c.template_id
       WHERE c.status = 'scheduled' AND c.scheduled_at <= NOW()
         AND c.processor_locked_at IS NULL AND c.processor_lock_token IS NULL
       ORDER BY c.scheduled_at, c.id LIMIT 10 FOR UPDATE OF c SKIP LOCKED`
    )
    const jobs: ScheduledJob[] = []
    let blocked = 0
    const pauseInvalid = async (campaign: ScheduledCampaign) => {
      const { rows } = await client.query<{ id: string }>(
        `UPDATE campaigns SET status = 'paused', pause_reason = 'config_missing', updated_at = NOW()
         WHERE id = $1 AND status = 'scheduled' AND scheduled_at <= NOW()
           AND processor_locked_at IS NULL AND processor_lock_token IS NULL
           AND owned_by IS NOT DISTINCT FROM $2::uuid RETURNING id`, [campaign.id, campaign.owned_by])
      blocked += rows.length
    }
    for (const campaign of campaigns) {
      const { rows: [owner] } = await client.query<Owner>(
        'SELECT role, sectors, is_active FROM users WHERE id = $1 FOR SHARE', [campaign.owned_by])
      if (!maySend(owner) || (!!campaign.list_id === !!campaign.prospect_list_id)) {
        await pauseInvalid(campaign); continue
      }
      // Audience ownership must still match at send time, not just creation.
      if (owner.role !== 'admin') {
        const table = campaign.list_id ? 'contact_lists' : 'prospect_lists'
        const { rows: [list] } = await client.query<{ owned_by: string | null }>(
          `SELECT owned_by FROM ${table} WHERE id = $1 FOR SHARE`, [campaign.list_id ?? campaign.prospect_list_id])
        if (list?.owned_by !== campaign.owned_by) { await pauseInvalid(campaign); continue }
      }
      const lockToken = randomUUID()
      const { rows } = await client.query<{ id: string }>(
        `UPDATE campaigns SET status = 'running', started_at = COALESCE(started_at, NOW()),
           pause_reason = NULL, processor_locked_at = NOW(), processor_lock_token = $2,
           updated_at = NOW()
         WHERE id = $1 AND status = 'scheduled' AND scheduled_at <= NOW()
           AND processor_locked_at IS NULL AND processor_lock_token IS NULL
           AND owned_by IS NOT DISTINCT FROM $3::uuid
         RETURNING id`, [campaign.id, lockToken, campaign.owned_by])
      if (rows.length) jobs.push({ campaign: { ...campaign, status: 'running' }, lockToken })
    }
    return { jobs, blocked }
  })
}

async function stopClaim(job: ScheduledJob, reason: 'config_missing' | 'systemic_error') {
  await query(
    `UPDATE campaigns SET status = CASE WHEN status = 'running' THEN 'paused' ELSE status END,
       pause_reason = CASE WHEN status = 'running' THEN $3 ELSE pause_reason END,
       processor_locked_at = NULL, processor_lock_token = NULL, updated_at = NOW()
     WHERE id = $1 AND processor_lock_token = $2`, [job.campaign.id, job.lockToken, reason])
}

// Seeding runs after claim COMMIT: its recipient FK must not wait on our own
// campaign row lock through another pool connection. Existing processors retain
// their status gates, provider fences and finally/token-based lock release.
export async function processScheduledCampaign(job: ScheduledJob): Promise<void> {
  const { campaign, lockToken } = job
  try {
    if (!isCampaignSchedulerEnabled()) { await stopClaim(job, 'config_missing'); return }
    const [current] = await query<Owner & { status: string; processor_lock_token: string | null }>(
      `SELECT c.status, c.processor_lock_token, u.role, u.sectors, u.is_active
       FROM campaigns c LEFT JOIN users u ON u.id = c.owned_by
       WHERE c.id = $1 AND c.owned_by IS NOT DISTINCT FROM $2::uuid`, [campaign.id, campaign.owned_by])
    if (!current) { await stopClaim(job, 'config_missing'); return }
    if (current.processor_lock_token !== lockToken) return
    if (current.status !== 'running' || !maySend(current)) { await stopClaim(job, 'config_missing'); return }
    const counts = campaign.prospect_list_id
      ? await createDispatchUnitsFromProspectList(campaign.id, campaign.prospect_list_id)
      : await createDispatchUnits(campaign.id, campaign.list_id)
    if (!counts.total) { await stopClaim(job, 'config_missing'); return }
    await query(
      `UPDATE campaigns SET total_targets = $3 WHERE id = $1 AND status = 'running' AND processor_lock_token = $2`,
      [campaign.id, lockToken, counts.total])
    // Recheck cancellation after asynchronous seeding before launching a processor.
    const [ready] = await query<Owner>(
      `SELECT u.role, u.sectors, u.is_active
       FROM campaigns c JOIN users u ON u.id = c.owned_by
       WHERE c.id = $1 AND c.status = 'running' AND c.processor_lock_token = $2
         AND c.owned_by IS NOT DISTINCT FROM $3::uuid`, [campaign.id, lockToken, campaign.owned_by])
    if (!maySend(ready)) { await stopClaim(job, 'config_missing'); return }
    if (campaign.use_multi_line) await processMultiLineInBackground(campaign, lockToken)
    else await processInBackground({ ...campaign, media_url: campaign.media_url ?? '' } as CampaignRow, lockToken)
  } catch (error) {
    clog.error({ event: 'scheduler.process.failed', campaignId: campaign.id,
      error: error instanceof Error ? error.message : 'Scheduled processor failed' })
    await stopClaim(job, 'systemic_error').catch(() => {})
  }
}
