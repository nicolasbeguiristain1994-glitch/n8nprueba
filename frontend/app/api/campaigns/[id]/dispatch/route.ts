import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser, isCampaignOwnerOrAdmin } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import {
  createDispatchUnits,
  acquireProcessorLock,
  processMultiLineInBackground,
  getDispatchSummary,
  type CampaignForDispatch,
} from '@/lib/campaign-distributor'

// ── GET /api/campaigns/[id]/dispatch ─────────────────────────────────────────
// Returns the dispatch progress summary for a campaign:
//   total, queued, processing, sent, failed, skipped,
//   eligible_lines, line_usage (per-line sent/failed counts)
//
// Access: campaigns:read

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'read')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  try {
    const [campaign] = await query<{ id: string; status: string; owned_by: string | null }>(
      'SELECT id, status, owned_by FROM campaigns WHERE id = $1',
      [id]
    )
    if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

    if (!isCampaignOwnerOrAdmin(auth.user, campaign.owned_by)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const summary = await getDispatchSummary(id)
    return NextResponse.json({ campaign_id: id, status: campaign.status, ...summary })
  } catch (e) {
    console.error('[GET /api/campaigns/[id]/dispatch]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── POST /api/campaigns/[id]/dispatch ────────────────────────────────────────
// Prepares dispatch units and starts the multi-line background processor.
//
// Steps:
//   1. Validate campaign (exists, owner check, resumable status)
//   2. Seed campaign_recipients from contact list (idempotent)
//   3. Acquire processor lock
//   4. Launch processMultiLineInBackground (fire-and-forget)
//   5. Return immediately: { started, total }
//
// Idempotency: safe to call repeatedly:
//   - Seed is ON CONFLICT DO NOTHING
//   - Lock prevents two concurrent processors
//   - Already-running campaigns return { alreadyProcessing: true }
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
    const rows = await query<CampaignForDispatch>('SELECT * FROM campaigns WHERE id = $1', [id])
    campaign = rows[0]
  } catch (e) {
    console.error('[POST /api/campaigns/[id]/dispatch] fetch error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

  if (!isCampaignOwnerOrAdmin(auth.user, campaign.owned_by)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const RESUMABLE = ['draft', 'scheduled', 'paused', 'running']
  if (!RESUMABLE.includes(campaign.status)) {
    return NextResponse.json(
      { error: `Campaign is already ${campaign.status}` },
      { status: 409 }
    )
  }

  if (!campaign.list_id) {
    return NextResponse.json({ error: 'Campaign has no contact list' }, { status: 400 })
  }

  // ── Seed recipients (idempotent) ────────────────────────────────────────────
  let unitCounts: { total: number; queued: number }
  try {
    unitCounts = await createDispatchUnits(id, campaign.list_id)
  } catch (e) {
    console.error('[POST /api/campaigns/[id]/dispatch] seed error:', e instanceof Error ? e.message : e)
    if (campaign.status !== 'running') {
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    unitCounts = { total: 0, queued: 0 }
  }

  if (unitCounts.total === 0 && campaign.status !== 'running') {
    return NextResponse.json({ error: 'No eligible contacts in list' }, { status: 400 })
  }

  // ── Acquire processor lock ──────────────────────────────────────────────────
  let lockToken: string | null = null
  try {
    lockToken = await acquireProcessorLock(id, campaign.status)
  } catch (e) {
    console.error('[POST /api/campaigns/[id]/dispatch] lock error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  if (!lockToken) {
    void audit({ req, action: 'send', resource: 'campaigns', resource_id: id,
      metadata: { mode: 'multi_line', alreadyProcessing: true } })
    return NextResponse.json({ started: false, alreadyProcessing: true })
  }

  // ── Launch background processor ─────────────────────────────────────────────
  const campaignSnapshot = campaign
  const capturedToken = lockToken
  ;(async () => {
    try {
      await processMultiLineInBackground(campaignSnapshot, capturedToken)
    } catch (e) {
      console.error(`[distributor ${id}] uncaught error:`, e instanceof Error ? e.message : e)
    }
  })()

  void audit({ req, action: 'send', resource: 'campaigns', resource_id: id,
    metadata: { mode: 'multi_line', started: true, total: unitCounts.total } })

  return NextResponse.json({
    started:          true,
    total:            unitCounts.total,
    queued:           unitCounts.queued,
    alreadyProcessing: false,
  })
}
