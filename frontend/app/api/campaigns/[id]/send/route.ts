import { POST as dispatchDynamic } from '../dispatch/route'
import { campaignAudienceError } from '@/lib/campaign-audience'
import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser, isCampaignOwnerOrAdmin } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { clog } from '@/lib/campaign-logger'
import {
  processInBackground,
  PROCESSOR_LOCK_MINUTES,
  type CampaignRow,
} from '@/lib/send-processor'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'send', 'send')
  if (!auth.ok) return auth.response
  const session = auth.user

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  // N8N_URL ya no es necesario — el processor llama a Evolution directamente

  // ── Fetch campaign ─────────────────────────────────────────────────────────
  let campaign: CampaignRow | undefined
  try {
    const rows = await query<CampaignRow>('SELECT c.*,l.is_dynamic FROM campaigns c LEFT JOIN contact_lists l ON l.id=c.list_id WHERE c.id = $1', [id])
    campaign = rows[0]
  } catch (e) {
    console.error('[campaign send] fetch error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

  if (!isCampaignOwnerOrAdmin(session, campaign.owned_by)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  if ((campaign as CampaignRow & {message_type?: string}).message_type === 'template') {
    return NextResponse.json({ error: 'Las campañas de plantilla deben usar el distribuidor de WhatsApp API' }, { status: 409 })
  }

  try {
    const audienceError = await campaignAudienceError(session, campaign)
    if (audienceError) return NextResponse.json({ error: audienceError.error }, { status: audienceError.status })
  } catch {
    return NextResponse.json({ error: 'No se pudo verificar la audiencia' }, { status: 500 })
  }

  const RESUMABLE = ['draft', 'scheduled', 'paused', 'running']
  if (!RESUMABLE.includes(campaign.status)) {
    return NextResponse.json({ error: `Campaign is already ${campaign.status}` }, { status: 409 })
  }

  if ((campaign as CampaignRow & {is_dynamic?:boolean}).is_dynamic) return dispatchDynamic(req,{params:Promise.resolve({id})})

  const isProspectList = !!campaign.prospect_list_id

  // ── Blacklist count (for audit metadata, solo para listas de contactos) ────
  let blacklistExcluded = 0
  if (!isProspectList) {
    try {
      const [blRow] = await query<{ count: string }>(
        `SELECT COUNT(DISTINCT c.id)::int AS count
         FROM contacts c
         JOIN contact_list_members clm ON clm.contact_id = c.id
         JOIN blacklist bl ON bl.phone_number_normalized = regexp_replace(c.phone_number, '[^0-9]', '', 'g')
         WHERE clm.list_id = $1
           AND bl.removed_at IS NULL`,
        [campaign.list_id]
      )
      blacklistExcluded = Number(blRow?.count ?? 0)
    } catch { /* non-critical */ }
  }

  // ── Seed recipients (idempotent) ───────────────────────────────────────────
  try {
    if (isProspectList) {
      await query(
        `INSERT INTO campaign_recipients (campaign_id, prospect_id, phone_number)
         SELECT $1, p.id, p.phone_number
         FROM prospect_list_members plm
         JOIN prospects p ON p.id = plm.prospect_id
         WHERE plm.prospect_list_id = $2
           AND p.status = 'active'
           AND p.stage IS DISTINCT FROM 'descartado'
           AND p.opt_in = true
           AND NOT EXISTS (
             SELECT 1 FROM blacklist bl
             WHERE bl.phone_number_normalized = regexp_replace(p.phone_number, '[^0-9]', '', 'g')
               AND bl.removed_at IS NULL
           )
         ON CONFLICT (campaign_id, prospect_id) WHERE prospect_id IS NOT NULL DO NOTHING`,
        [id, campaign.prospect_list_id]
      )
    } else {
      await query(
        `INSERT INTO campaign_recipients (campaign_id, contact_id, phone_number)
         SELECT $1, c.id, c.phone_number
         FROM contacts c
         JOIN contact_list_members clm ON clm.contact_id = c.id
         WHERE clm.list_id = $2
           AND c.opt_in_marketing = true
           AND c.do_not_contact   = false
           AND c.status           = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM blacklist bl
             WHERE bl.phone_number_normalized = regexp_replace(c.phone_number, '[^0-9]', '', 'g')
               AND bl.removed_at IS NULL
           )
         ON CONFLICT (campaign_id, contact_id) WHERE contact_id IS NOT NULL DO NOTHING`,
        [id, campaign.list_id]
      )
    }
  } catch (e) {
    console.error('[campaign send] populate recipients error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'No se pudieron preparar los destinatarios' }, { status: 500 })
  }

  // ── Count pending work ─────────────────────────────────────────────────────
  let totalPending = 0
  try {
    const [row] = await query<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM campaign_recipients
       WHERE campaign_id = $1 AND status IN ('pending','sending')`,
      [id]
    )
    totalPending = Number(row?.count || 0)
  } catch (e) {
    console.error('[campaign send] count pending error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'No se pudieron consultar los destinatarios pendientes' }, { status: 500 })
  }

  if (totalPending === 0 && campaign.status !== 'running') {
    let totals: { total: string; sent: string } | undefined
    try {
      ;[totals] = await query<{ total: string; sent: string }>(
        `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE status IN ('sent','failed','skipped'))::text AS sent
       FROM campaign_recipients WHERE campaign_id = $1`,
        [id]
      )
    } catch (e) {
      console.error('[campaign send] totals error:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'No se pudo comprobar el estado de los destinatarios' }, { status: 500 })
    }

    if (Number(totals?.sent || 0) > 0) {
      try {
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
      } catch (e) {
        console.error('[campaign send] completion error:', e instanceof Error ? e.message : e)
        return NextResponse.json({ error: 'No se pudo actualizar el estado de la campaña' }, { status: 500 })
      }
      return NextResponse.json(
        { error: 'La campaña ya envió todos sus contactos. Se marcó como completada.' },
        { status: 409 }
      )
    }

    // Explain why there are no eligible recipients
    let eligibilityMsg = 'No hay destinatarios en la lista.'
    let eligibilityBreakdown: Record<string, number> | null = null
    try {
      if (isProspectList) {
        const [brow] = await query<{ total_in_list: string; ineligible: string; blacklisted: string }>(`
          SELECT
            COUNT(p.id)::text AS total_in_list,
            COUNT(p.id) FILTER (
              WHERE p.status != 'active' OR p.opt_in = false OR p.stage = 'descartado'
            )::text AS ineligible,
            COUNT(p.id) FILTER (
              WHERE p.status = 'active' AND p.opt_in = true AND (p.stage IS DISTINCT FROM 'descartado')
                AND EXISTS (
                  SELECT 1 FROM blacklist bl
                  WHERE bl.phone_number_normalized = regexp_replace(p.phone_number,'[^0-9]','','g')
                    AND bl.removed_at IS NULL
                )
            )::text AS blacklisted
          FROM prospect_list_members plm
          JOIN prospects p ON p.id = plm.prospect_id
          WHERE plm.prospect_list_id = $1
        `, [campaign.prospect_list_id])
        if (brow) {
          const totalInList = Number(brow.total_in_list ?? 0)
          const ineligible  = Number(brow.ineligible   ?? 0)
          const blacklisted = Number(brow.blacklisted  ?? 0)
          eligibilityBreakdown = { total_in_list: totalInList, ineligible, blacklisted }
          if (totalInList === 0) {
            eligibilityMsg = 'La lista de difusión no tiene prospectos.'
          } else {
            const parts: string[] = []
            if (ineligible  > 0) parts.push(`${ineligible} inelegibles (baja, sin opt-in o descartados)`)
            if (blacklisted > 0) parts.push(`${blacklisted} en blacklist`)
            const detail = parts.length > 0 ? ` Excluidos: ${parts.join(', ')}.` : ''
            eligibilityMsg = `No hay prospectos elegibles (${totalInList} en lista).${detail}`
          }
          console.warn(`[campaign ${id}] 0 prospectos elegibles:`, eligibilityBreakdown)
        }
      } else {
        const [brow] = await query<{
          total_in_list: string; opted_out: string; do_not_contact: string
          inactive: string; blacklisted: string
        }>(`
          SELECT
            COUNT(DISTINCT c.id)::text AS total_in_list,
            COUNT(DISTINCT c.id) FILTER (WHERE c.opt_in_marketing = false)::text AS opted_out,
            COUNT(DISTINCT c.id) FILTER (WHERE c.do_not_contact   = true)::text  AS do_not_contact,
            COUNT(DISTINCT c.id) FILTER (
              WHERE c.status != 'active' AND c.opt_in_marketing = true AND c.do_not_contact = false
            )::text AS inactive,
            COUNT(DISTINCT c.id) FILTER (
              WHERE c.opt_in_marketing = true AND c.do_not_contact = false AND c.status = 'active'
                AND EXISTS (
                  SELECT 1 FROM blacklist bl
                  WHERE bl.phone_number_normalized = regexp_replace(c.phone_number,'[^0-9]','','g')
                    AND bl.removed_at IS NULL
                )
            )::text AS blacklisted
          FROM contacts c
          JOIN contact_list_members clm ON clm.contact_id = c.id
          WHERE clm.list_id = $1
        `, [campaign.list_id])
        if (brow) {
          const totalInList  = Number(brow.total_in_list  ?? 0)
          const optedOut     = Number(brow.opted_out      ?? 0)
          const doNotContact = Number(brow.do_not_contact ?? 0)
          const inactive     = Number(brow.inactive       ?? 0)
          const blacklisted  = Number(brow.blacklisted    ?? 0)
          eligibilityBreakdown = { total_in_list: totalInList, opted_out: optedOut,
            do_not_contact: doNotContact, inactive, blacklisted }
          if (totalInList === 0) {
            eligibilityMsg = 'La lista no tiene contactos.'
          } else {
            const parts: string[] = []
            if (optedOut     > 0) parts.push(`${optedOut} sin opt-in de marketing`)
            if (doNotContact > 0) parts.push(`${doNotContact} con do_not_contact`)
            if (inactive     > 0) parts.push(`${inactive} inactivos`)
            if (blacklisted  > 0) parts.push(`${blacklisted} en blacklist`)
            const detail = parts.length > 0 ? ` Excluidos: ${parts.join(', ')}.` : ''
            eligibilityMsg = `No hay contactos elegibles (${totalInList} en lista).${detail}`
          }
          console.warn(`[campaign ${id}] 0 contactos elegibles:`, eligibilityBreakdown)
        }
      }
    } catch (e) {
      console.error('[campaign send] eligibility error:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'No se pudo consultar la elegibilidad de la lista' }, { status: 500 })
    }
    return NextResponse.json({ error: eligibilityMsg, breakdown: eligibilityBreakdown }, { status: 400 })
  }

  // ── Acquire processor lock ─────────────────────────────────────────────────
  let lockToken: string | null = null
  try {
    const newToken = crypto.randomUUID()
    const rows = await query<{ id: string }>(
      `UPDATE campaigns
       SET status = CASE
             WHEN status IN ('draft','scheduled','paused') THEN 'running'
             ELSE status
           END,
           started_at = CASE
             WHEN status IN ('draft','scheduled','paused') THEN COALESCE(started_at, NOW())
             ELSE started_at
           END,
           pause_reason         = NULL,
           processor_locked_at  = NOW(),
           processor_lock_token = $2,
           total_targets = (
             SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = $1
           )
       WHERE id = $1
         AND status IN ('draft','scheduled','paused','running')
         AND (processor_locked_at IS NULL
              OR processor_locked_at < NOW() - INTERVAL '${PROCESSOR_LOCK_MINUTES} minutes')
       RETURNING id`,
      [id, newToken]
    )
    if (rows[0]) lockToken = newToken
  } catch (e) {
    console.error('[campaign send] lock acquisition error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  if (!lockToken) {
    void audit({ req, action: 'send', resource: 'campaigns', resource_id: id,
      metadata: { alreadyProcessing: true } })
    return NextResponse.json({ started: false, alreadyProcessing: true })
  }

  if (campaign.status === 'paused') {
    clog.info({ event: 'campaign.resumed', campaignId: id, mode: 'single-line' })
  }

  // ── Launch background processor — fire and forget ──────────────────────────
  const campaignSnapshot = campaign
  const capturedToken = lockToken
  ;(async () => {
    try {
      await processInBackground(campaignSnapshot, capturedToken)
    } catch (e) {
      clog.critical({
        event: 'processor.crashed', campaignId: id, mode: 'single-line',
        error: e instanceof Error ? e.message : String(e),
        detail: 'processInBackground lanzó error no capturado — pausando campaña',
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
        if (!released.length) clog.warn({ event: 'processor.crash.cleanup.skipped', campaignId: id, mode: 'single-line', detail: 'El estado o el propietario del lock cambió; no se modificó la campaña' })
      } catch (cleanupError) {
        clog.critical({ event: 'processor.crash.cleanup.failed', campaignId: id, mode: 'single-line', error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) })
      }
    }
  })()

  void audit({ req, action: 'send', resource: 'campaigns', resource_id: id,
    metadata: { started: true, total: totalPending, blacklist_excluded: blacklistExcluded } })
  return NextResponse.json({ started: true, total: totalPending, blacklist_excluded: blacklistExcluded })
}
