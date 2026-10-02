import { campaignAudienceError } from '@/lib/campaign-audience'
import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser, isCampaignOwnerOrAdmin } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { clog } from '@/lib/campaign-logger'
import {
  createDispatchUnits,
  createDispatchUnitsFromProspectList,
  acquireProcessorLock,
  processMultiLineInBackground,
  getDispatchSummary,
  getContactEligibilityBreakdown,
  formatEligibilityError,
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

    const summary = await getDispatchSummary(id, campaign.owned_by)
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
    const rows = await query<CampaignForDispatch>(
      `SELECT c.*, wt.name AS template_name, wt.language AS template_language, wt.waba_id AS template_waba_id, wt.status AS template_status
       FROM campaigns c
       LEFT JOIN whatsapp_templates wt ON wt.id = c.template_id
       WHERE c.id = $1`,
      [id]
    )
    campaign = rows[0]
  } catch (e) {
    console.error('[POST /api/campaigns/[id]/dispatch] fetch error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

  if (!isCampaignOwnerOrAdmin(auth.user, campaign.owned_by)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (campaign.message_type === 'template' && (!campaign.template_name || !campaign.template_waba_id || campaign.template_status !== 'APROBADA')) {
    return NextResponse.json({ error: 'La plantilla no está aprobada o no tiene una cuenta de WhatsApp validada' }, { status: 409 })
  }


  try {
    const audienceError = await campaignAudienceError(auth.user, campaign)
    if (audienceError) return NextResponse.json({ error: audienceError.error }, { status: audienceError.status })
  } catch {
    return NextResponse.json({ error: 'No se pudo verificar la audiencia' }, { status: 500 })
  }

  const RESUMABLE = ['draft', 'scheduled', 'paused', 'running']
  if (!RESUMABLE.includes(campaign.status)) {
    return NextResponse.json(
      { error: `Campaign is already ${campaign.status}` },
      { status: 409 }
    )
  }

  const campaignExt = campaign as CampaignForDispatch & { prospect_list_id?: string | null }
  const hasContactList  = !!campaign.list_id
  const hasProspectList = !!campaignExt.prospect_list_id

  if (!hasContactList && !hasProspectList) {
    return NextResponse.json({ error: 'Campaign has no contact list or prospect list' }, { status: 400 })
  }

  // ── Seed recipients (idempotent) ────────────────────────────────────────────
  let unitCounts: { total: number; queued: number }
  try {
    if (hasProspectList) {
      unitCounts = await createDispatchUnitsFromProspectList(id, campaignExt.prospect_list_id!)
    } else {
      unitCounts = await createDispatchUnits(id, campaign.list_id)
    }
  } catch (e) {
    console.error('[POST /api/campaigns/[id]/dispatch] seed error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'No se pudieron preparar los destinatarios' }, { status: 500 })
  }

  if (unitCounts.total === 0 && campaign.status !== 'running') {
    if (hasContactList) {
      try {
        const breakdown = await getContactEligibilityBreakdown(campaign.list_id)
        const errMsg = formatEligibilityError(breakdown)
        return NextResponse.json({ error: errMsg, breakdown }, { status: 400 })
      } catch (e) {
        console.error('[POST /dispatch] eligibility error:', e instanceof Error ? e.message : e)
        return NextResponse.json({ error: 'No se pudo consultar la elegibilidad de la lista' }, { status: 500 })
      }
    }
    return NextResponse.json(
      { error: 'No hay prospectos elegibles en la lista de difusión.' },
      { status: 400 }
    )
  }

  // All recipients already processed (none pending) — covers campaigns stuck in
  // 'paused' OR 'running' (processor finished but completion step was missed).
  // Completion may not clear another processor's lock or race pending work.
  if (unitCounts.queued === 0) {
    try {
      const [processed] = await query<{ count: string }>(
        `SELECT COUNT(*) FILTER (WHERE status IN ('sent','failed','skipped'))::text AS count
       FROM campaign_recipients WHERE campaign_id = $1`,
        [id]
      )
      if (Number(processed?.count || 0) > 0) {
        const completed = await query<{ id: string }>(
          `UPDATE campaigns
         SET status = 'completed', completed_at = COALESCE(completed_at, NOW()),
             pause_reason = NULL
         WHERE id = $1 AND status = $2::campaign_status
           AND owned_by IS NOT DISTINCT FROM $3::uuid
           AND processor_locked_at IS NULL AND processor_lock_token IS NULL
           AND NOT EXISTS (SELECT 1 FROM campaign_recipients
                           WHERE campaign_id = $1 AND status IN ('pending','sending'))
         RETURNING id`,
          [id, campaign.status, campaign.owned_by]
        )
        if (!completed.length) return NextResponse.json({ error: 'El estado cambió o hay un procesador activo. Actualizá la campaña.' }, { status: 409 })
        return NextResponse.json(
          { error: 'La campaña ya envió todos sus contactos. Se marcó como completada.' },
          { status: 409 }
        )
      }
    } catch (e) {
      console.error('[POST /dispatch] completion check error:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'No se pudo comprobar o actualizar el estado de la campaña' }, { status: 500 })
    }
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

  // Marcar la lista de difusión como usada ahora que el procesador arrancó.
  // Fire-and-forget: una falla aquí no debe bloquear el dispatch.
  if (campaignExt.prospect_list_id) {
    void query(
      `UPDATE prospect_lists SET last_used_at = NOW() WHERE id = $1`,
      [campaignExt.prospect_list_id]
    ).catch(e => console.warn('[dispatch] last_used_at update failed:', (e as Error)?.message))
  }

  if (campaign.status === 'paused') {
    clog.info({ event: 'campaign.resumed', campaignId: id, mode: 'multi-line' })
  }

  // ── Launch background processor ─────────────────────────────────────────────
  const campaignSnapshot = campaign
  const capturedToken = lockToken
  ;(async () => {
    try {
      await processMultiLineInBackground(campaignSnapshot, capturedToken)
    } catch (e) {
      clog.critical({
        event: 'processor.crashed', campaignId: id, mode: 'multi-line',
        error: e instanceof Error ? e.message : String(e),
        detail: 'processMultiLineInBackground lanzó error no capturado — pausando campaña',
      })
      try {
        const released = await query<{ id: string }>(
          `UPDATE campaigns
         SET status = 'paused', pause_reason = 'systemic_error',
             processor_locked_at = NULL, processor_lock_token = NULL
         WHERE id = $1 AND status = 'running' AND processor_lock_token = $2
         RETURNING id`,
          [id, capturedToken],
        )
        if (!released.length) clog.warn({ event: 'processor.crash.cleanup.skipped', campaignId: id, mode: 'multi-line', detail: 'El estado o el propietario del lock cambió; no se modificó la campaña' })
      } catch (cleanupError) {
        clog.critical({ event: 'processor.crash.cleanup.failed', campaignId: id, mode: 'multi-line', error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) })
      }
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
