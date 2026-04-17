import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

// ── Constants ──────────────────────────────────────────────────────────────
const STALE_SENDING_MINUTES = 15   // rows stuck in 'sending' longer than this are recovered
const BATCH_SIZE            = 50   // contacts claimed per loop tick

// ── Types ──────────────────────────────────────────────────────────────────
type CampaignRow = {
  id: string; name: string; message: string; messages: string[] | null
  media_url: string; list_id: string; antiblock_delay_min: number
  antiblock_delay_max: number; personalize_name: boolean; status: string
}

type RecipientRow = {
  id: string; contact_id: string; phone_number: string
  first_name: string; attempts: number
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Pick a random variant from the campaign message pool. */
function pickMessage(campaign: CampaignRow): string {
  const pool = Array.isArray(campaign.messages) && campaign.messages.length > 0
    ? campaign.messages
    : [campaign.message]
  return pool[Math.floor(Math.random() * pool.length)]
}

/** Build personalised message text. */
function personalize(raw: string, firstName: string, campaign: CampaignRow): string {
  const nameValue = campaign.personalize_name !== false ? (firstName || '') : ''
  return raw
    .replace(/\{\{nombre\}\}/gi, nameValue)
    .replace(/\{\{name\}\}/gi,   nameValue)
}

/**
 * Re-queue or fail stale 'sending' rows (locked > STALE_SENDING_MINUTES ago).
 * If whatsapp_messages already has a sent entry for the recipient, mark it sent.
 * Otherwise reset to pending so the current run picks it up.
 */
async function recoverStaleRows(campaignId: string): Promise<void> {
  try {
    // Mark as sent if a whatsapp_messages row confirms delivery
    await query(
      `UPDATE campaign_recipients cr
       SET    status = 'sent', updated_at = NOW()
       FROM   whatsapp_messages wm
       WHERE  cr.campaign_id = $1
         AND  cr.status      = 'sending'
         AND  cr.locked_at   < NOW() - INTERVAL '${STALE_SENDING_MINUTES} minutes'
         AND  wm.campaign_id = cr.campaign_id
         AND  wm.contact_id  = cr.contact_id
         AND  wm.status IN ('sent', 'delivered', 'read')`,
      [campaignId]
    )

    // Reset the rest back to pending
    await query(
      `UPDATE campaign_recipients
       SET    status = 'pending', locked_at = NULL, updated_at = NOW()
       WHERE  campaign_id = $1
         AND  status      = 'sending'
         AND  locked_at   < NOW() - INTERVAL '${STALE_SENDING_MINUTES} minutes'`,
      [campaignId]
    )
  } catch (e) {
    console.error(`[campaign ${campaignId}] stale recovery error:`, e instanceof Error ? e.message : e)
  }
}

/**
 * Atomically claim up to BATCH_SIZE pending recipients using FOR UPDATE SKIP LOCKED.
 * Sets status = 'sending' and stamps locked_at so stale recovery can detect crashes.
 */
async function claimBatch(campaignId: string): Promise<RecipientRow[]> {
  const rows = await query<RecipientRow>(
    `UPDATE campaign_recipients cr
     SET    status    = 'sending',
            locked_at = NOW(),
            attempts  = attempts + 1,
            updated_at = NOW()
     FROM (
       SELECT r.id
       FROM   campaign_recipients r
       WHERE  r.campaign_id = $1
         AND  r.status      = 'pending'
       ORDER BY r.created_at
       LIMIT  ${BATCH_SIZE}
       FOR UPDATE SKIP LOCKED
     ) sub
     JOIN contacts c ON c.id = cr.contact_id
     WHERE cr.id = sub.id
     RETURNING cr.id, cr.contact_id, cr.phone_number,
               c.first_name, cr.attempts`,
    [campaignId]
  )
  return rows
}

/** Sync progress counters from aggregate; returns { sent, failed, pending }. */
async function syncCounters(
  campaignId: string
): Promise<{ sent: number; failed: number; pending: number }> {
  try {
    const [row] = await query<{ sent: string; failed: string; pending: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'sent')    AS sent,
         COUNT(*) FILTER (WHERE status = 'failed')  AS failed,
         COUNT(*) FILTER (WHERE status IN ('pending','sending')) AS pending
       FROM campaign_recipients
       WHERE campaign_id = $1`,
      [campaignId]
    )
    const sent    = Number(row?.sent    || 0)
    const failed  = Number(row?.failed  || 0)
    const pending = Number(row?.pending || 0)

    await query(
      `UPDATE campaigns SET total_sent = $1, total_failed = $2 WHERE id = $3`,
      [sent, failed, campaignId]
    )

    return { sent, failed, pending }
  } catch {
    return { sent: 0, failed: 0, pending: 0 }
  }
}

/**
 * Send a single contact via n8n webhook.
 * Returns 'sent' | 'failed'.
 */
async function sendOne(
  campaignId: string,
  campaign: CampaignRow,
  recipient: RecipientRow,
  n8nUrl: string
): Promise<'sent' | 'failed'> {
  const rawMsg        = pickMessage(campaign)
  const personalizedMsg = personalize(rawMsg, recipient.first_name, campaign)

  try {
    const res = await fetch(`${n8nUrl}/webhook/send-whatsapp`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone:               recipient.phone_number,
        message:             personalizedMsg,
        campaign_id:         campaignId,
        campaign_name:       campaign.name,
        contact_id:          recipient.contact_id,
        media_url:           campaign.media_url || undefined,
        source:              'campaign',
        antiblock_delay_min: campaign.antiblock_delay_min,
        antiblock_delay_max: campaign.antiblock_delay_max,
      }),
    })

    if (res.ok) {
      let evolutionMsgId: string | null = null
      try {
        const data = await res.json()
        evolutionMsgId = data?.key?.id || data?.id || null
      } catch { /* n8n returned empty body */ }

      // Record outbound message
      await query(
        `INSERT INTO whatsapp_messages
           (contact_id, campaign_id, phone_number, message_body, direction, status,
            evolution_message_id, sent_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'outbound', 'sent', $5, NOW(), NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        [recipient.contact_id, campaignId, recipient.phone_number,
         personalizedMsg, evolutionMsgId]
      )

      await query(
        `UPDATE campaign_recipients
         SET status = 'sent', sent_at = NOW(), locked_at = NULL,
             message_body = $1, evolution_message_id = $2, updated_at = NOW()
         WHERE id = $3`,
        [personalizedMsg, evolutionMsgId, recipient.id]
      )

      return 'sent'
    }

    // HTTP error from n8n
    let errDetail: string
    try { const d = await res.json(); errDetail = d?.message || String(res.status) }
    catch { errDetail = String(res.status) }

    console.error(`[campaign ${campaignId}] HTTP ${errDetail} for ${recipient.phone_number}`)
    await recordFailure(campaignId, recipient, personalizedMsg, errDetail)
    return 'failed'

  } catch (e) {
    const errMsg = e instanceof Error ? e.message : 'network error'
    console.error(`[campaign ${campaignId}] exception for ${recipient.phone_number}:`, errMsg)
    await recordFailure(campaignId, recipient, personalizedMsg, errMsg)
    return 'failed'
  }
}

async function recordFailure(
  campaignId: string,
  recipient: RecipientRow,
  personalizedMsg: string,
  errDetail: string
): Promise<void> {
  await query(
    `INSERT INTO whatsapp_messages
       (contact_id, campaign_id, phone_number, message_body, direction, status,
        failed_at, error_detail, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'outbound', 'failed', NOW(), $5, NOW(), NOW())
     ON CONFLICT DO NOTHING`,
    [recipient.contact_id, campaignId, recipient.phone_number, personalizedMsg, errDetail]
  )

  await query(
    `UPDATE campaign_recipients
     SET status = 'failed', failed_at = NOW(), locked_at = NULL,
         error_detail = $1, updated_at = NOW()
     WHERE id = $2`,
    [errDetail, recipient.id]
  )
}

// ── Background processor ───────────────────────────────────────────────────

/**
 * Process pending recipients in a loop.
 * - Recovers stale 'sending' rows first (crash-safety).
 * - Claims a batch atomically with FOR UPDATE SKIP LOCKED.
 * - Stops when campaign is paused/cancelled or no pending rows remain.
 */
async function processInBackground(campaign: CampaignRow, n8nUrl: string): Promise<void> {
  const id = campaign.id

  // Recover any stale rows before starting
  await recoverStaleRows(id)

  while (true) {
    // Re-read campaign status to honour pause/cancel mid-run
    const [current] = await query<{ status: string }>(
      'SELECT status FROM campaigns WHERE id = $1', [id]
    )
    if (!current || current.status === 'paused' || current.status === 'cancelled') break

    const batch = await claimBatch(id)
    if (!batch.length) break  // no more pending rows

    for (const recipient of batch) {
      // Re-check status before each send
      const [check] = await query<{ status: string }>(
        'SELECT status FROM campaigns WHERE id = $1', [id]
      )
      if (!check || check.status === 'paused' || check.status === 'cancelled') {
        // Release our lock on this recipient
        await query(
          `UPDATE campaign_recipients
           SET status = 'pending', locked_at = NULL, attempts = attempts - 1, updated_at = NOW()
           WHERE id = $1 AND status = 'sending'`,
          [recipient.id]
        )
        return
      }

      await sendOne(id, campaign, recipient, n8nUrl)

      // Antiblock delay between messages (not after the very last one in the batch)
      const isLastInBatch = recipient === batch[batch.length - 1]
      if (!isLastInBatch) {
        const delaySec = Math.floor(
          Math.random() * (campaign.antiblock_delay_max - campaign.antiblock_delay_min + 1)
        ) + campaign.antiblock_delay_min
        await new Promise(r => setTimeout(r, delaySec * 1000))
      }
    }

    // Sync counters after each batch
    const { pending } = await syncCounters(id)
    if (pending === 0) break

    // Small gap between batches — honour antiblock for first item of next batch too
    const delaySec = Math.floor(
      Math.random() * (campaign.antiblock_delay_max - campaign.antiblock_delay_min + 1)
    ) + campaign.antiblock_delay_min
    await new Promise(r => setTimeout(r, delaySec * 1000))
  }

  // Final sync and completion check
  await syncCounters(id)
  const [finalState] = await query<{ status: string }>(
    'SELECT status FROM campaigns WHERE id = $1', [id]
  )
  if (finalState?.status === 'running') {
    // Check for any remaining work (pending might have been added by another path)
    const { pending } = await syncCounters(id)
    if (pending === 0) {
      await query(
        `UPDATE campaigns SET status = 'completed', completed_at = NOW() WHERE id = $1`, [id]
      )
    }
  }
}

// ── Route handler ──────────────────────────────────────────────────────────

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  // ── N8N_URL must exist before any DB mutation ────────────────────────────
  const N8N_URL = process.env.N8N_URL
  if (!N8N_URL) return NextResponse.json({ error: 'N8N_URL not configured' }, { status: 500 })

  // ── Fetch campaign details (read-only) ────────────────────────────────────
  let campaign: CampaignRow | undefined
  try {
    const rows = await query<CampaignRow>('SELECT * FROM campaigns WHERE id = $1', [id])
    campaign = rows[0]
  } catch (e) {
    console.error('[campaign send] fetch campaign error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

  // Already running: re-attach processor (handles stuck-running recovery)
  const RESUMABLE = ['draft', 'scheduled', 'paused', 'running']
  if (!RESUMABLE.includes(campaign.status)) {
    return NextResponse.json({ error: `Campaign is already ${campaign.status}` }, { status: 409 })
  }

  // ── Populate campaign_recipients (idempotent) ─────────────────────────────
  try {
    await query(
      `INSERT INTO campaign_recipients (campaign_id, contact_id, phone_number)
       SELECT $1, c.id, c.phone_number
       FROM contacts c
       JOIN contact_list_members clm ON clm.contact_id = c.id
       WHERE clm.list_id = $2
         AND c.opt_in_marketing = true
         AND c.do_not_contact   = false
         AND c.status           = 'active'
       ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
      [id, campaign.list_id]
    )
  } catch (e) {
    console.error('[campaign send] populate recipients error:', e instanceof Error ? e.message : e)
    // Non-fatal: attempt send anyway if rows already exist
  }

  // ── Count eligible recipients ─────────────────────────────────────────────
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
  }

  if (totalPending === 0 && campaign.status !== 'running') {
    return NextResponse.json({ error: 'No contacts in list' }, { status: 400 })
  }

  // ── Atomic status transition ──────────────────────────────────────────────
  // Transitions draft/scheduled/paused → running.
  // If already running, the UPDATE returns no rows — that's fine, we re-attach.
  let campaignRow: { id: string } | undefined
  try {
    const rows = await query<{ id: string }>(
      `UPDATE campaigns
       SET status = 'running', started_at = COALESCE(started_at, NOW()),
           total_targets = (
             SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = $1
           )
       WHERE id = $1 AND status IN ('draft', 'scheduled', 'paused')
       RETURNING id`,
      [id]
    )
    campaignRow = rows[0]
  } catch (e) {
    console.error('[campaign send] status update error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  // If already 'running', still proceed (re-attach to process stuck campaigns)
  if (!campaignRow && campaign.status !== 'running') {
    // Lost the race — another request transitioned status
    return NextResponse.json({ error: `Campaign is already ${campaign.status}` }, { status: 409 })
  }

  // ── Process in background — respond immediately ───────────────────────────
  // Capture campaign snapshot for the background closure (avoid re-read race)
  const campaignSnapshot = campaign
  ;(async () => {
    try {
      await processInBackground(campaignSnapshot, N8N_URL)
    } catch (e) {
      console.error(`[campaign ${id}] processInBackground uncaught:`, e instanceof Error ? e.message : e)
    }
  })()

  return NextResponse.json({ started: true, total: totalPending })
}
