import { query } from '@/lib/db'
import { ContactFrequencyEngine } from '@/lib/contact-frequency/ContactFrequencyEngine'
import { clog } from '@/lib/campaign-logger'
import { getEligibleLines, sendViaEvolution } from '@/lib/campaign-distributor'

// Política de fail-open del motor de frecuencia (ver comentario en el catch del freq gate):
// Si el motor lanza, el envío continúa. Esta constante controla cuántos fail-opens
// acumulados por sesión disparan un warning explícito en los logs.
const FREQ_FAIL_OPEN_WARN_THRESHOLD = 10

// ── Constants ────────────────────────────────────────────────────────────────
export const STALE_SENDING_MINUTES  = 15
export const PROCESSOR_LOCK_MINUTES = 30
export const LOCK_HEARTBEAT_EVERY   = 50

// ── Types ────────────────────────────────────────────────────────────────────
export type CampaignRow = {
  id: string; name: string; message: string; messages: string[] | null
  media_url: string; list_id: string | null; prospect_list_id: string | null
  antiblock_delay_min: number; antiblock_delay_max: number
  personalize_name: boolean; status: string; owned_by: string | null
}

export type RecipientRow = {
  id: string; contact_id: string | null; prospect_id: string | null; phone_number: string
  first_name: string; attempts: number
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function pickMessage(campaign: CampaignRow): string {
  const pool = Array.isArray(campaign.messages) && campaign.messages.length > 0
    ? campaign.messages
    : [campaign.message]
  return pool[Math.floor(Math.random() * pool.length)]
}

export function personalize(raw: string, firstName: string, campaign: CampaignRow): string {
  const nameValue = campaign.personalize_name !== false ? (firstName || '') : ''
  return raw
    .replace(/\{\{nombre\}\}/gi, nameValue)
    .replace(/\{\{name\}\}/gi,   nameValue)
}

export function antiblockDelay(campaign: CampaignRow): Promise<void> {
  const delaySec = Math.floor(
    Math.random() * (campaign.antiblock_delay_max - campaign.antiblock_delay_min + 1)
  ) + campaign.antiblock_delay_min
  return new Promise(r => setTimeout(r, delaySec * 1000))
}

// ── Stale recovery ───────────────────────────────────────────────────────────

export async function recoverStaleRows(campaignId: string): Promise<void> {
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
    // Queued in-flight: do not re-send — mark failed to avoid duplicate
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
    // Unconfirmed: reset to pending so processor re-sends
    await query(
      `UPDATE campaign_recipients
       SET    status = 'pending', locked_at = NULL, updated_at = NOW()
       WHERE  campaign_id = $1
         AND  status      = 'sending'
         AND  locked_at   < NOW() - INTERVAL '${STALE_SENDING_MINUTES} minutes'`,
      [campaignId]
    )
  } catch (e) {
    clog.error({
      event: 'stale.recovery.error', campaignId, mode: 'single-line',
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

// ── Atomic claim ─────────────────────────────────────────────────────────────

export async function claimOne(campaignId: string): Promise<RecipientRow | undefined> {
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
       RETURNING id, contact_id, prospect_id, phone_number, attempts
     )
     SELECT cl.id,
            cl.contact_id,
            cl.prospect_id,
            cl.phone_number,
            cl.attempts,
            COALESCE(c.first_name, p.first_name, '') AS first_name
     FROM   claimed cl
     LEFT JOIN contacts  c ON c.id = cl.contact_id
     LEFT JOIN prospects p ON p.id = cl.prospect_id`,
    [campaignId]
  )
  return rows[0]
}

// ── Counter sync ─────────────────────────────────────────────────────────────

export async function syncCounters(
  campaignId: string
): Promise<{ sent: number; failed: number; skipped: number; pending: number }> {
  const [row] = await query<{ sent: string; failed: string; skipped: string; pending: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'sent')                 AS sent,
       COUNT(*) FILTER (WHERE status = 'failed')               AS failed,
       COUNT(*) FILTER (WHERE status = 'skipped')              AS skipped,
       COUNT(*) FILTER (WHERE status IN ('pending','sending'))  AS pending
     FROM campaign_recipients
     WHERE campaign_id = $1`,
    [campaignId]
  )
  const sent    = Number(row?.sent    || 0)
  const failed  = Number(row?.failed  || 0)
  const skipped = Number(row?.skipped || 0)
  const pending = Number(row?.pending || 0)
  // Non-critical write — swallow so a transient error doesn't abort the loop
  await query(
    `UPDATE campaigns SET total_sent = $1, total_failed = $2, total_skipped = $3 WHERE id = $4`,
    [sent, failed, skipped, campaignId]
  ).catch(e =>
    clog.error({
      event: 'sync.counters.write.error', campaignId, mode: 'single-line',
      error: e instanceof Error ? e.message : String(e),
    })
  )
  return { sent, failed, skipped, pending }
}

// ── Record failure ───────────────────────────────────────────────────────────

export async function recordFailure(
  campaignId: string,
  recipient: RecipientRow,
  personalizedMsg: string,
  errDetail: string
): Promise<void> {
  await query(
    `UPDATE whatsapp_messages
     SET status       = 'failed',
         failed_at    = NOW(),
         error_detail = $1,
         updated_at   = NOW()
     WHERE campaign_recipient_id = $2
       AND status = 'queued'`,
    [errDetail, recipient.id]
  ).catch(e =>
    clog.error({
      event: 'record.failure.update.wm.error', campaignId, mode: 'single-line',
      recipientId: recipient.id, error: e instanceof Error ? e.message : String(e),
    })
  )
  // Safety net: insert a failed row if the pre-insert never ran (very early crash)
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
  ).catch(e =>
    clog.error({
      event: 'record.failure.insert.wm.error', campaignId, mode: 'single-line',
      recipientId: recipient.id, error: e instanceof Error ? e.message : String(e),
    })
  )
  await query(
    `UPDATE campaign_recipients
     SET status = 'failed', failed_at = NOW(), locked_at = NULL,
         error_detail = $1, updated_at = NOW()
     WHERE id = $2`,
    [errDetail, recipient.id]
  ).catch(e =>
    clog.error({
      event: 'record.failure.update.cr.error', campaignId, mode: 'single-line',
      recipientId: recipient.id, error: e instanceof Error ? e.message : String(e),
    })
  )
}

// ── Send one contact ─────────────────────────────────────────────────────────

export async function sendOne(
  campaignId: string,
  campaign: CampaignRow,
  recipient: RecipientRow,
): Promise<'sent' | 'failed'> {
  const personalizedMsg = personalize(pickMessage(campaign), recipient.first_name, campaign)

  // Pick the best eligible line — same logic as multi-line distributor
  const eligibleLines = await getEligibleLines()
  if (eligibleLines.length === 0) {
    await recordFailure(campaignId, recipient, personalizedMsg, 'no-eligible-lines')
    clog.warn({
      event: 'recipient.failed', campaignId, mode: 'single-line',
      recipientId: recipient.id, contactId: recipient.contact_id,
      attempt: recipient.attempts, provider: 'evolution',
      error: 'no-eligible-lines',
    })
    return 'failed'
  }
  const line = eligibleLines[0]

  // Pre-insert 'queued' row — stale recovery can detect in-flight messages
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
    clog.warn({
      event: 'pre.insert.queued.error', campaignId, mode: 'single-line',
      recipientId: recipient.id, error: e instanceof Error ? e.message : String(e),
    })
  )

  try {
    const { messageId } = await sendViaEvolution(
      line,
      recipient.phone_number,
      personalizedMsg,
      campaign.media_url || null,
    )

    // Increment line counters (same as multi-line distributor)
    await query(
      `UPDATE whatsapp_lines
       SET msgs_sent_hour  = msgs_sent_hour  + 1,
           msgs_sent_today = msgs_sent_today + 1,
           updated_at      = NOW()
       WHERE id = $1`,
      [line.id],
    ).catch(() => {})

    await query(
      `UPDATE whatsapp_messages
       SET status               = 'sent',
           evolution_message_id = $1,
           sent_at              = NOW(),
           updated_at           = NOW()
       WHERE campaign_recipient_id = $2
         AND status = 'queued'`,
      [messageId, recipient.id]
    )
    // Fallback: ensure a 'sent' row exists if the pre-insert never ran
    await query(
      `INSERT INTO whatsapp_messages
         (contact_id, campaign_id, phone_number, message_body, direction, status,
          evolution_message_id, sent_at, campaign_recipient_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'outbound', 'sent', $5, NOW(), $6, NOW(), NOW())
       ON CONFLICT (campaign_recipient_id)
         WHERE campaign_recipient_id IS NOT NULL
       DO UPDATE SET
         status               = CASE WHEN whatsapp_messages.status IN ('delivered','read') THEN whatsapp_messages.status ELSE 'sent' END,
         evolution_message_id = COALESCE(whatsapp_messages.evolution_message_id, EXCLUDED.evolution_message_id),
         updated_at           = NOW()`,
      [recipient.contact_id, campaignId, recipient.phone_number, personalizedMsg, messageId, recipient.id]
    ).catch(e =>
      clog.warn({
        event: 'sent.fallback.insert.error', campaignId, mode: 'single-line',
        recipientId: recipient.id, error: e instanceof Error ? e.message : String(e),
      })
    )
    await query(
      `UPDATE campaign_recipients
       SET status = 'sent', sent_at = NOW(), locked_at = NULL,
           message_body = $1, evolution_message_id = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [personalizedMsg, messageId, recipient.id]
    )
    clog.info({
      event:       'recipient.sent',
      campaignId,
      mode:        'single-line',
      recipientId: recipient.id,
      contactId:   recipient.contact_id,
      phone:       recipient.phone_number.slice(-4).padStart(recipient.phone_number.length, '*'),
      attempt:     recipient.attempts,
      provider:    'evolution',
      lineInstance: line.evolution_instance,
    })
    return 'sent'

  } catch (e) {
    const errMsg = e instanceof Error ? e.message : 'evolution error'
    await recordFailure(campaignId, recipient, personalizedMsg, errMsg)
    clog.warn({
      event:       'recipient.failed',
      campaignId,
      mode:        'single-line',
      recipientId: recipient.id,
      contactId:   recipient.contact_id,
      attempt:     recipient.attempts,
      provider:    'evolution',
      error:       errMsg,
    })
    return 'failed'
  }
}

// ── Background processor ─────────────────────────────────────────────────────

export async function processInBackground(
  campaign: CampaignRow,
  lockToken: string,
): Promise<void> {
  const id = campaign.id
  let sendCount = 0
  let freqEngineFailOpenCount = 0

  clog.info({ event: 'processor.start', campaignId: id, mode: 'single-line' })

  try {
    await recoverStaleRows(id)

    while (true) {
      // ── 1. Status gate ──────────────────────────────────────────────────
      const [current] = await query<{ status: string }>(
        'SELECT status FROM campaigns WHERE id = $1', [id]
      )
      if (!current || current.status === 'paused' || current.status === 'cancelled') {
        clog.info({
          event: 'processor.stopped', campaignId: id, mode: 'single-line',
          reason: 'status-gate', status: current?.status ?? 'not-found',
        })
        break
      }

      // ── 2. Claim one recipient ──────────────────────────────────────────
      const recipient = await claimOne(id)
      if (!recipient) {
        clog.info({ event: 'processor.drained', campaignId: id, mode: 'single-line' })
        break
      }

      // ── 3. Frequency gate ───────────────────────────────────────────────
      // Only applies to contacts. Prospects don't have frequency profiles.
      // BLOCK → skip (freq limit exceeded). DELAY/ALLOW → send.
      // Engine error → log and continue (availability > strict freq control).
      let freqDecision: 'ALLOW' | 'DELAY' | 'BLOCK' = 'ALLOW'
      let freqReason = ''
      if (recipient.contact_id) {
        try {
          const freqResult = await ContactFrequencyEngine.atomicEvaluateAndRecord(
            {
              contactId:    recipient.contact_id,
              operatorId:   campaign.owned_by,
              campaignId:   id,
              segMonto:     null,
              segActividad: null,
            },
            {
              contactId:           recipient.contact_id,
              campaignId:          id,
              operatorId:          campaign.owned_by,
              phoneNumber:         recipient.phone_number,
              campaignRecipientId: recipient.id,
            },
          )
          freqDecision = freqResult.decision
          freqReason   = freqResult.reason
        } catch (freqErr) {
          // Fail-open: log error pero continuar. Política explícita — disponibilidad
          // de campaña > control de frecuencia estricto ante fallos de infraestructura.
          freqEngineFailOpenCount++
          clog.error({
            event:       'freq.engine.error',
            campaignId:  id,
            mode:        'single-line',
            recipientId: recipient.id,
            contactId:   recipient.contact_id,
            error:       freqErr instanceof Error ? freqErr.message : String(freqErr),
          })
          if (freqEngineFailOpenCount === FREQ_FAIL_OPEN_WARN_THRESHOLD) {
            clog.warn({
              event: 'freq.engine.failopen.accumulated', campaignId: id, mode: 'single-line',
              count: freqEngineFailOpenCount,
              detail: 'motor de frecuencia con errores repetidos — enviando sin control de frecuencia',
            })
          }
        }
      }

      if (freqDecision === 'BLOCK') {
        await query(
          `UPDATE campaign_recipients
           SET status = 'skipped', error_detail = $1,
               failed_at = NOW(), locked_at = NULL, updated_at = NOW()
           WHERE id = $2`,
          [`[freq-blocked] ${freqReason}`, recipient.id],
        ).catch(e =>
          clog.error({
            event: 'recipient.skipped.write.error', campaignId: id, mode: 'single-line',
            recipientId: recipient.id, error: e instanceof Error ? e.message : String(e),
          })
        )
        clog.warn({
          event:       'recipient.skipped',
          campaignId:  id,
          mode:        'single-line',
          recipientId: recipient.id,
          contactId:   recipient.contact_id,
          reason:      'freq-blocked',
          detail:      freqReason,
        })
        const { pending: pendingAfterSkip } = await syncCounters(id)
        if (pendingAfterSkip === 0) break
        continue  // no antiblock delay for skipped recipients
      }

      // ── 4. Send ─────────────────────────────────────────────────────────
      await sendOne(id, campaign, recipient)
      sendCount++

      // ── 5. Sync counters ────────────────────────────────────────────────
      const { pending } = await syncCounters(id)
      if (pending === 0) break

      // ── 6. Antiblock delay ──────────────────────────────────────────────
      await antiblockDelay(campaign)

      // ── 7. Heartbeat: extend lock for long campaigns ────────────────────
      if (sendCount % LOCK_HEARTBEAT_EVERY === 0) {
        await query(
          `UPDATE campaigns SET processor_locked_at = NOW()
           WHERE id = $1 AND processor_lock_token = $2`, [id, lockToken]
        ).catch(e =>
          clog.error({
            event: 'heartbeat.error', campaignId: id, mode: 'single-line',
            error: e instanceof Error ? e.message : String(e),
          })
        )
      }
    }

    // Final counter sync + completion check
    const { sent, failed, skipped, pending } = await syncCounters(id)
    const [finalState] = await query<{ status: string }>(
      'SELECT status FROM campaigns WHERE id = $1', [id]
    )
    if (finalState?.status === 'running' && pending === 0) {
      await query(
        `UPDATE campaigns SET status = 'completed', completed_at = NOW() WHERE id = $1`, [id]
      )
      clog.info({
        event: 'campaign.completed', campaignId: id, mode: 'single-line',
        sent, failed, skipped,
      })
    } else {
      clog.info({
        event: 'processor.end', campaignId: id, mode: 'single-line',
        sent, failed, skipped, pending,
        finalStatus: finalState?.status ?? 'unknown',
      })
    }

  } finally {
    await query(
      `UPDATE campaigns
       SET processor_locked_at = NULL, processor_lock_token = NULL
       WHERE id = $1 AND processor_lock_token = $2`, [id, lockToken]
    ).catch(e =>
      clog.error({
        event: 'lock.release.error', campaignId: id, mode: 'single-line',
        error: e instanceof Error ? e.message : String(e),
      })
    )
  }
}
