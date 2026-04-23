import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser, isCampaignOwnerOrAdmin } from '@/lib/permissions'
import { audit } from '@/lib/audit'

// ── Constants ──────────────────────────────────────────────────────────────
const STALE_SENDING_MINUTES  = 15  // rows stuck in 'sending' longer than this are recovered
const PROCESSOR_LOCK_MINUTES = 30  // stale processor lock timeout
const LOCK_HEARTBEAT_EVERY   = 50  // refresh processor_locked_at every N sends

// ── Types ──────────────────────────────────────────────────────────────────
type CampaignRow = {
  id: string; name: string; message: string; messages: string[] | null
  media_url: string; list_id: string; antiblock_delay_min: number
  antiblock_delay_max: number; personalize_name: boolean; status: string
  owned_by: string | null
}

type RecipientRow = {
  id: string; contact_id: string; phone_number: string
  first_name: string; attempts: number
}

// ── Helpers ────────────────────────────────────────────────────────────────

function pickMessage(campaign: CampaignRow): string {
  const pool = Array.isArray(campaign.messages) && campaign.messages.length > 0
    ? campaign.messages
    : [campaign.message]
  return pool[Math.floor(Math.random() * pool.length)]
}

function personalize(raw: string, firstName: string, campaign: CampaignRow): string {
  const nameValue = campaign.personalize_name !== false ? (firstName || '') : ''
  return raw
    .replace(/\{\{nombre\}\}/gi, nameValue)
    .replace(/\{\{name\}\}/gi,   nameValue)
}

function antiblockDelay(campaign: CampaignRow): Promise<void> {
  const delaySec = Math.floor(
    Math.random() * (campaign.antiblock_delay_max - campaign.antiblock_delay_min + 1)
  ) + campaign.antiblock_delay_min
  return new Promise(r => setTimeout(r, delaySec * 1000))
}

// ── Stale recovery ─────────────────────────────────────────────────────────

/**
 * Recover rows stuck in 'sending' longer than STALE_SENDING_MINUTES.
 * Uses campaign_recipient_id FK to confirm sends without a contact_id join.
 * - If whatsapp_messages confirms delivery → mark 'sent'.
 * - If whatsapp_messages row is in queued/sent/delivered/read → mark 'failed'
 *   with 'stale-queued-no-resend' (message may have been sent; do not re-send).
 * - Otherwise → reset to 'pending' so the processor re-sends.
 */
async function recoverStaleRows(campaignId: string): Promise<void> {
  try {
    // Confirmed sent: whatsapp_messages row with final status
    await query(
      `UPDATE campaign_recipients cr
       SET    status = 'sent', locked_at = NULL, updated_at = NOW()
       FROM   whatsapp_messages wm
       WHERE  cr.campaign_id = $1
         AND  cr.status      = 'sending'
         AND  cr.locked_at   < NOW() - INTERVAL '${STALE_SENDING_MINUTES} minutes'
         AND  wm.campaign_recipient_id = cr.id
         AND  wm.status IN ('sent', 'delivered', 'read')`,
      [campaignId]
    )
    // Queued (in-flight but unconfirmed): mark failed to avoid duplicate send
    await query(
      `UPDATE campaign_recipients cr
       SET    status = 'failed', locked_at = NULL, updated_at = NOW(),
              error_detail = 'stale-queued-no-resend'
       FROM   whatsapp_messages wm
       WHERE  cr.campaign_id = $1
         AND  cr.status      = 'sending'
         AND  cr.locked_at   < NOW() - INTERVAL '${STALE_SENDING_MINUTES} minutes'
         AND  wm.campaign_recipient_id = cr.id
         AND  wm.status = 'queued'`,
      [campaignId]
    )
    // Unconfirmed: reset to pending for re-send
    await query(
      `UPDATE campaign_recipients
       SET    status = 'pending', locked_at = NULL, updated_at = NOW()
       WHERE  campaign_id = $1
         AND  status      = 'sending'
         AND  locked_at   < NOW() - INTERVAL '${STALE_SENDING_MINUTES} minutes'`,
      [campaignId]
    )
  } catch (e) {
    console.error(`[campaign ${campaignId}] stale recovery error:`,
      e instanceof Error ? e.message : e)
  }
}

// ── Atomic claim ───────────────────────────────────────────────────────────

/**
 * Atomically claim one pending recipient with FOR UPDATE SKIP LOCKED.
 * Returns undefined if no pending rows remain.
 *
 * Uses a data-modifying CTE (valid Postgres 9.1+) to avoid a separate contacts
 * query: the UPDATE runs first, then the outer SELECT joins contacts for
 * first_name in the same round-trip.
 *
 * FOR UPDATE SKIP LOCKED inside the subquery ensures concurrent processors
 * (if the lock somehow fails) cannot claim the same row.
 */
async function claimOne(campaignId: string): Promise<RecipientRow | undefined> {
  const rows = await query<RecipientRow>(
    `WITH claimed AS (
       UPDATE campaign_recipients
       SET    status     = 'sending',
              locked_at  = NOW(),
              attempts   = attempts + 1,
              updated_at = NOW()
       WHERE  id = (
         SELECT id
         FROM   campaign_recipients
         WHERE  campaign_id = $1
           AND  status      = 'pending'
         ORDER BY created_at
         LIMIT  1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, contact_id, phone_number, attempts
     )
     SELECT cl.id,
            cl.contact_id,
            cl.phone_number,
            cl.attempts,
            COALESCE(c.first_name, '') AS first_name
     FROM   claimed cl
     LEFT JOIN contacts c ON c.id = cl.contact_id`,
    [campaignId]
  )
  return rows[0]
}

// ── Counter sync ───────────────────────────────────────────────────────────

/**
 * Reads aggregate counts from campaign_recipients and writes them back to
 * campaigns.total_sent/total_failed.
 * 'pending' here includes rows still in 'sending' (stale or in-flight),
 * so the campaign won't be marked complete until all are resolved.
 */
async function syncCounters(
  campaignId: string
): Promise<{ sent: number; failed: number; pending: number }> {
  try {
    const [row] = await query<{ sent: string; failed: string; pending: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'sent')               AS sent,
         COUNT(*) FILTER (WHERE status = 'failed')             AS failed,
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

// ── Send one contact ───────────────────────────────────────────────────────

/**
 * Call n8n, then persist result.
 *
 * Idempotency key: recipient.id (campaign_recipients.id = campaign_recipient_id).
 * Sent to n8n as `campaign_recipient_id` and `dedup_key` so n8n can deduplicate
 * on its side if it receives the same request twice.
 *
 * Pre-insert 'queued' row before n8n call so that if the process crashes between
 * sending and recording, stale recovery can detect the in-flight message.
 * - On success: UPDATE to 'sent' only if status = 'queued'.
 * - On failure: UPDATE to 'failed' only if status = 'queued'.
 * - Pre-insert uses ON CONFLICT DO UPDATE only when status NOT IN final states,
 *   so a prior 'sent'/'delivered'/'read' row is never overwritten.
 */
async function sendOne(
  campaignId: string,
  campaign: CampaignRow,
  recipient: RecipientRow,
  n8nUrl: string
): Promise<'sent' | 'failed'> {
  const personalizedMsg = personalize(pickMessage(campaign), recipient.first_name, campaign)

  // ── Pre-insert 'queued' row before n8n call (idempotency) ──────────────────
  // If there is already a final-status row, this is a no-op (status stays as-is).
  await query(
    `INSERT INTO whatsapp_messages
       (contact_id, campaign_id, phone_number, message_body, direction, status,
        campaign_recipient_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'outbound', 'queued', $5, NOW(), NOW())
     ON CONFLICT (campaign_recipient_id)
       WHERE campaign_recipient_id IS NOT NULL
     DO UPDATE SET updated_at = NOW()
     WHERE whatsapp_messages.status NOT IN ('sent', 'delivered', 'read')`,
    [recipient.contact_id, campaignId, recipient.phone_number,
     personalizedMsg, recipient.id]
  ).catch(e =>
    console.error(`[campaign ${campaignId}] pre-insert queued error:`,
      e instanceof Error ? e.message : e)
  )

  try {
    const res = await fetch(`${n8nUrl}/webhook/send-whatsapp`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone:                 recipient.phone_number,
        message:               personalizedMsg,
        campaign_id:           campaignId,
        campaign_name:         campaign.name,
        contact_id:            recipient.contact_id,
        // Idempotency keys for n8n deduplication
        campaign_recipient_id: recipient.id,
        dedup_key:             recipient.id,
        media_url:             campaign.media_url || undefined,
        source:                'campaign',
        antiblock_delay_min:   campaign.antiblock_delay_min,
        antiblock_delay_max:   campaign.antiblock_delay_max,
      }),
    })

    if (res.ok) {
      let evolutionMsgId: string | null = null
      try {
        const data = await res.json()
        evolutionMsgId = data?.key?.id || data?.id || null
      } catch { /* n8n returned empty body */ }

      // Update from 'queued' → 'sent' — only if still in queued state
      await query(
        `UPDATE whatsapp_messages
         SET status               = 'sent',
             evolution_message_id = $1,
             sent_at              = NOW(),
             updated_at           = NOW()
         WHERE campaign_recipient_id = $2
           AND status = 'queued'`,
        [evolutionMsgId, recipient.id]
      )

      await query(
        `UPDATE campaign_recipients
         SET status = 'sent', sent_at = NOW(), locked_at = NULL,
             message_body = $1, evolution_message_id = $2,
             updated_at = NOW()
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
  // Update queued → failed only; never overwrite a confirmed 'sent' row.
  await query(
    `UPDATE whatsapp_messages
     SET status       = 'failed',
         failed_at    = NOW(),
         error_detail = $1,
         updated_at   = NOW()
     WHERE campaign_recipient_id = $2
       AND status = 'queued'`,
    [errDetail, recipient.id]
  )
  // If no queued row existed yet (very early failure), insert a failed row
  await query(
    `INSERT INTO whatsapp_messages
       (contact_id, campaign_id, phone_number, message_body, direction, status,
        failed_at, error_detail, campaign_recipient_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'outbound', 'failed', NOW(), $5, $6, NOW(), NOW())
     ON CONFLICT (campaign_recipient_id)
       WHERE campaign_recipient_id IS NOT NULL
     DO NOTHING`,
    [recipient.contact_id, campaignId, recipient.phone_number,
     personalizedMsg, errDetail, recipient.id]
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
 * Main processing loop. Holds the processor lock for its entire lifetime.
 * The try/finally guarantees the lock is released even if an uncaught error
 * propagates out of the loop.
 *
 * lockToken is used for all heartbeat and release queries so only the owner
 * of the lock can extend or release it.
 *
 * Flow per iteration:
 *   1. Read campaign status — bail if paused/cancelled.
 *   2. claimOne() — bail if no pending rows.
 *   3. sendOne() — updates recipient + whatsapp_messages atomically.
 *   4. syncCounters() — persist aggregate counts; bail if pending drops to 0.
 *   5. Antiblock delay before next claim.
 *   6. Heartbeat: refresh processor_locked_at every LOCK_HEARTBEAT_EVERY sends.
 */
async function processInBackground(campaign: CampaignRow, n8nUrl: string, lockToken: string): Promise<void> {
  const id = campaign.id
  let sendCount = 0

  try {
    // Recover any stale rows from previous crashed runs before starting
    await recoverStaleRows(id)

    while (true) {
      // ── 1. Status gate ─────────────────────────────────────────────────
      const [current] = await query<{ status: string }>(
        'SELECT status FROM campaigns WHERE id = $1', [id]
      )
      if (!current || current.status === 'paused' || current.status === 'cancelled') break

      // ── 2. Claim one recipient ─────────────────────────────────────────
      const recipient = await claimOne(id)
      if (!recipient) break  // no more pending rows

      // ── 3. Send ────────────────────────────────────────────────────────
      await sendOne(id, campaign, recipient, n8nUrl)
      sendCount++

      // ── 4. Sync counters ───────────────────────────────────────────────
      const { pending } = await syncCounters(id)
      if (pending === 0) break

      // ── 5. Antiblock delay ─────────────────────────────────────────────
      // Re-check status after delay so pause/cancel is noticed promptly
      await antiblockDelay(campaign)

      // ── 6. Heartbeat: keep processor lock alive for long campaigns ─────
      // Only extends the lock if this processor still owns it (token match).
      if (sendCount % LOCK_HEARTBEAT_EVERY === 0) {
        await query(
          `UPDATE campaigns SET processor_locked_at = NOW()
           WHERE id = $1 AND processor_lock_token = $2`, [id, lockToken]
        ).catch(e =>
          console.error(`[campaign ${id}] heartbeat error:`, e instanceof Error ? e.message : e)
        )
      }
    }

    // Final counter sync + completion
    const { pending } = await syncCounters(id)
    const [finalState] = await query<{ status: string }>(
      'SELECT status FROM campaigns WHERE id = $1', [id]
    )
    if (finalState?.status === 'running' && pending === 0) {
      await query(
        `UPDATE campaigns SET status = 'completed', completed_at = NOW() WHERE id = $1`, [id]
      )
    }

  } finally {
    // Always release the processor lock — only if we still own it (token match)
    await query(
      `UPDATE campaigns
       SET processor_locked_at = NULL, processor_lock_token = NULL
       WHERE id = $1 AND processor_lock_token = $2`, [id, lockToken]
    ).catch(e =>
      console.error(`[campaign ${id}] failed to release processor lock:`,
        e instanceof Error ? e.message : e)
    )
  }
}

// ── Route handler ──────────────────────────────────────────────────────────

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'send', 'send')
  if (!auth.ok) return auth.response
  const session = auth.user

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const N8N_URL = process.env.N8N_URL
  if (!N8N_URL) return NextResponse.json({ error: 'N8N_URL not configured' }, { status: 500 })

  // ── Fetch campaign ────────────────────────────────────────────────────────
  let campaign: CampaignRow | undefined
  try {
    const rows = await query<CampaignRow>('SELECT * FROM campaigns WHERE id = $1', [id])
    campaign = rows[0]
  } catch (e) {
    console.error('[campaign send] fetch error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

  // Ownership check — non-admin can only send their own campaigns
  if (!isCampaignOwnerOrAdmin(session, campaign.owned_by)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const RESUMABLE = ['draft', 'scheduled', 'paused', 'running']
  if (!RESUMABLE.includes(campaign.status)) {
    return NextResponse.json({ error: `Campaign is already ${campaign.status}` }, { status: 409 })
  }

  // ── Populate campaign_recipients (idempotent) ─────────────────────────────
  // Hard-fail for fresh starts — if we can't seed recipients, there's nothing to send.
  // For re-attach (running), best-effort: rows are already there from the first run.
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
    if (campaign.status !== 'running') {
      // Fresh start: no recipients seeded — cannot proceed
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
    // Re-attach: recipients from the original run are intact — log and continue
  }

  // ── Count pending work ────────────────────────────────────────────────────
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

  // ── Atomic: acquire processor lock + (if needed) transition status ────────
  //
  // Single UPDATE handles all cases:
  //   draft/scheduled/paused → transitions to running, acquires lock.
  //   running                → only acquires lock (status unchanged via CASE).
  //
  // A unique lock token (UUID) is generated per acquisition so that heartbeat
  // and release queries only succeed for the current owner.
  //
  // The (processor_locked_at IS NULL OR locked_at < now - 30 min) guard is the
  // only thing preventing a second concurrent processor from launching.
  // If another POST holds a recent lock, this UPDATE matches 0 rows and we
  // return { started: false, alreadyProcessing: true }.
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

  // ── Launch background processor — respond immediately ─────────────────────
  const campaignSnapshot = campaign
  const capturedToken = lockToken
  ;(async () => {
    try {
      await processInBackground(campaignSnapshot, N8N_URL, capturedToken)
    } catch (e) {
      console.error(`[campaign ${id}] processInBackground uncaught:`,
        e instanceof Error ? e.message : e)
      // Lock was released in processInBackground's finally block
    }
  })()

  void audit({ req, action: 'send', resource: 'campaigns', resource_id: id,
    metadata: { started: true, total: totalPending } })
  return NextResponse.json({ started: true, total: totalPending })
}
