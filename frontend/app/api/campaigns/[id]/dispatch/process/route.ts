import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser, isCampaignOwnerOrAdmin } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import {
  acquireProcessorLock,
  processMultiLineInBackground,
  getDispatchSummary,
  type CampaignForDispatch,
} from '@/lib/campaign-distributor'

// ── POST /api/campaigns/[id]/dispatch/process ─────────────────────────────────
//
// Manual trigger for the multi-line background processor.
// Use this to:
//   - Resume a campaign that was auto-paused (no eligible lines)
//   - Continue processing when no background processor is running
//   - Manually step through a campaign batch-by-batch
//
// Assumes dispatch units already exist (call POST /dispatch first to seed them).
// Does NOT re-seed recipients — use POST /dispatch for that.
//
// Safe under concurrent calls: processor lock prevents two processors running
// simultaneously. Concurrent calls return { alreadyProcessing: true }.
//
// Idempotent: calling this on a completed/cancelled campaign returns a 409.
//
// Access: campaigns:send

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'send', 'send')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  let campaign: CampaignForDispatch | undefined
  try {
    const rows = await query<CampaignForDispatch>(
      `SELECT c.*, wt.name AS template_name, wt.language AS template_language
       FROM campaigns c
       LEFT JOIN whatsapp_templates wt ON wt.id = c.template_id
       WHERE c.id = $1`,
      [id]
    )
    campaign = rows[0]
  } catch (e) {
    console.error('[POST /dispatch/process] fetch error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

  if (!isCampaignOwnerOrAdmin(auth.user, campaign.owned_by)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Allow processing from paused (manual resume) or running (already in progress)
  const PROCESSABLE = ['draft', 'scheduled', 'paused', 'running']
  if (!PROCESSABLE.includes(campaign.status)) {
    return NextResponse.json(
      { error: `Campaign is already ${campaign.status}` },
      { status: 409 }
    )
  }

  // Check that dispatch units exist — prevent confusing 0-unit runs
  const [unitCount] = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM campaign_recipients
     WHERE campaign_id = $1 AND status IN ('pending','sending')`,
    [id]
  ).catch(() => [{ count: '0' }])

  if (Number(unitCount?.count || 0) === 0) {
    const summary = await getDispatchSummary(id, campaign.owned_by).catch(() => null)
    return NextResponse.json({
      started: false,
      reason:  'no_pending_units',
      summary,
    })
  }

  // ── Acquire processor lock (same pattern as /dispatch) ──────────────────────
  let lockToken: string | null = null
  try {
    lockToken = await acquireProcessorLock(id, campaign.status)
  } catch (e) {
    console.error('[POST /dispatch/process] lock error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  if (!lockToken) {
    return NextResponse.json({ started: false, alreadyProcessing: true })
  }

  // ── Launch background processor ─────────────────────────────────────────────
  const campaignSnapshot = campaign
  const capturedToken    = lockToken
  ;(async () => {
    try {
      await processMultiLineInBackground(campaignSnapshot, capturedToken)
    } catch (e) {
      console.error(`[distributor/process ${id}] uncaught:`, e instanceof Error ? e.message : e)
    }
  })()

  void audit({ req, action: 'send', resource: 'campaigns', resource_id: id,
    metadata: { mode: 'multi_line_resume' } })

  return NextResponse.json({ started: true, alreadyProcessing: false })
}
