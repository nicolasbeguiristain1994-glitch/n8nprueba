import { query } from '@/lib/db'
import { prepareCampaignRouting, getCampaignAssignedLine, campaignRoutingCondition } from '@/lib/campaign-routing'
import { ContactFrequencyEngine } from '@/lib/contact-frequency/ContactFrequencyEngine'
import { clog } from '@/lib/campaign-logger'
import {
  buildTemplatePayload, getEligibleLines, sendViaCloud, sendViaEvolution,
  CampaignLineUnavailableError, CloudSendOutcomeUnknownError,
  type CampaignTemplateParams,
} from '@/lib/campaign-distributor'
import { CloudApiError } from '@/lib/cloud-api/errors'

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
  message_type?: 'text' | 'template'
  template_id?: string | null; template_name?: string | null
  template_language?: string | null; template_params?: CampaignTemplateParams | null
  template_waba_id?: string | null; template_status?: string | null
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

export async function claimOne(campaignId: string, eligibleLineIds: string[]): Promise<RecipientRow | undefined> {
  const rows = await query<RecipientRow>(
    `WITH claimed AS (
       UPDATE campaign_recipients
       SET    status     = 'sending',
              locked_at  = NOW(),
              attempts   = attempts + 1,
              updated_at = NOW()
       WHERE  id = (
         SELECT cr.id
         FROM   campaign_recipients cr
         WHERE  cr.campaign_id = $1
           AND  cr.status = 'pending'
           AND ${campaignRoutingCondition('cr', '$2')}
         ORDER BY cr.created_at, cr.id
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
    [campaignId, eligibleLineIds]
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
  errDetail: string,
  preserveMessage = false,
): Promise<void> {
  if (!preserveMessage) {
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
  }
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

async function deferRecipient(recipient: RecipientRow, reason: string): Promise<'deferred'> {
  await query(
    `UPDATE campaign_recipients
     SET status = 'pending', locked_at = NULL, line_id = NULL,
         attempts = GREATEST(attempts - 1, 0), error_detail = $2,
         updated_at = NOW() WHERE id = $1`,
    [recipient.id, reason],
  )
  return 'deferred'
}

export async function sendOne(
  campaignId: string,
  campaign: CampaignRow,
  recipient: RecipientRow,
): Promise<'sent' | 'failed' | 'skipped' | 'deferred'> {
  const isTemplate = campaign.message_type === 'template'
  const personalizedMsg = isTemplate
    ? `[template:${campaign.template_name ?? ''}]`
    : personalize(pickMessage(campaign), recipient.first_name, campaign)

  if (isTemplate && (!campaign.template_id || !campaign.template_name ||
      !campaign.template_language || !campaign.template_waba_id || campaign.template_status !== 'APROBADA')) {
    await recordFailure(campaignId, recipient, personalizedMsg, 'template-not-approved-or-incomplete', true)
    return 'failed'
  }

  // Scope both providers to the campaign owner's lines, including the kill switch.
  let eligibleLines: Awaited<ReturnType<typeof getEligibleLines>> = []
  try {
    eligibleLines = await getEligibleLines(campaign.owned_by)
    if (isTemplate) {
      eligibleLines = eligibleLines.filter(line =>
        line.line_type === 'cloud' && line.waba_id === campaign.template_waba_id)
    }
  } catch (linesErr) {
    clog.error({
      event: 'eligible.lines.error', campaignId, mode: 'single-line',
      recipientId: recipient.id,
      error: linesErr instanceof Error ? linesErr.message : String(linesErr),
    })
    return deferRecipient(recipient, 'no-eligible-lines-error')
  }
  const assignedLineId = await getCampaignAssignedLine(campaignId, recipient.phone_number)
  const line = eligibleLines.find(candidate => candidate.id === assignedLineId)
  if (!line) return deferRecipient(recipient, 'assigned-line-unavailable')

  // Only an inserted row or a definite previous failure may authorize a send.
  // In-flight and already accepted rows must survive manual recipient resets.
  try {
    const queued = await query<{ id: string }>(
      `INSERT INTO whatsapp_messages
         (contact_id, campaign_id, phone_number, message_body, direction, status,
          campaign_recipient_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'outbound', 'queued', $5, NOW(), NOW())
       ON CONFLICT (campaign_recipient_id)
         WHERE campaign_recipient_id IS NOT NULL
       DO UPDATE SET status = 'queued', message_body = EXCLUDED.message_body,
         error_detail = NULL, failed_at = NULL, updated_at = NOW()
       WHERE whatsapp_messages.status = 'failed'
         AND whatsapp_messages.evolution_message_id IS NULL
         AND COALESCE(whatsapp_messages.error_detail, '') NOT LIKE '[provider-outcome-unknown-no-resend]%'
       RETURNING id`,
      [recipient.contact_id, campaignId, recipient.phone_number, personalizedMsg, recipient.id]
    )
    if (queued.length === 0) {
      const [existing] = await query<{ status: string; evolution_message_id: string | null }>(
        `SELECT status, evolution_message_id FROM whatsapp_messages WHERE campaign_recipient_id = $1`,
        [recipient.id],
      )
      if (existing && ['sent', 'delivered', 'read'].includes(existing.status)) {
        await query(
          `UPDATE campaign_recipients
           SET status = 'sent', sent_at = COALESCE(sent_at, NOW()), locked_at = NULL,
               evolution_message_id = $1, error_detail = NULL, updated_at = NOW()
           WHERE id = $2`,
          [existing.evolution_message_id, recipient.id],
        )
        return 'sent'
      }
      // Keep the message fence untouched: a queued provider result is unknown.
      await query(
        `UPDATE campaign_recipients
         SET status = 'failed', failed_at = NOW(), locked_at = NULL,
             error_detail = '[provider-outcome-unknown-no-resend] existing message fence', updated_at = NOW()
         WHERE id = $1`,
        [recipient.id],
      )
      return 'failed'
    }
    await query(
      `UPDATE campaign_recipients SET line_id = $1, updated_at = NOW() WHERE id = $2`,
      [line.id, recipient.id],
    )
  } catch (e) {
    clog.error({
      event: 'pre.insert.queued.error', campaignId, mode: 'single-line',
      recipientId: recipient.id, error: e instanceof Error ? e.message : String(e),
    })
    // Do not turn an existing queued message into a retryable failure.
    await query(
      `UPDATE campaign_recipients
       SET status = 'failed', failed_at = NOW(), locked_at = NULL,
           error_detail = 'pre-send-persistence-error', updated_at = NOW()
       WHERE id = $1`,
      [recipient.id],
    ).catch(() => {})
    return 'failed'
  }

  let messageId: string | null
  try {
    const result = line.line_type === 'cloud'
      ? await sendViaCloud(line, recipient.phone_number, isTemplate
          ? {
              kind: 'template',
              content: buildTemplatePayload({
                template_name: campaign.template_name!,
                template_language: campaign.template_language ?? null,
                template_params: campaign.template_params ?? null,
              }, recipient),
              wabaId: campaign.template_waba_id!,
              templateId: campaign.template_id!,
            }
          : { kind: 'text', body: personalizedMsg, mediaUrl: campaign.media_url || null }, campaignId)
      : await sendViaEvolution(line, recipient.phone_number, personalizedMsg, campaign.media_url || null)
    messageId = result.messageId
  } catch (e) {
    if (e instanceof CampaignLineUnavailableError) {
      // The line was disabled or exhausted after selection; no provider was called.
      await query(
        `UPDATE whatsapp_messages
         SET status = 'failed', failed_at = NOW(),
             error_detail = 'line-unavailable-before-send', updated_at = NOW()
         WHERE campaign_recipient_id = $1 AND status = 'queued'`,
        [recipient.id],
      )
      return deferRecipient(recipient, 'line-unavailable-before-send')
    }
    const errMsg = e instanceof Error ? e.message : 'provider error'
    const skip = line.line_type === 'cloud' && e instanceof CloudApiError &&
      [131021, 131026, 131047].includes(e.code ?? -1)
    const unknownOutcome = e instanceof CloudSendOutcomeUnknownError
    const detail = unknownOutcome
      ? `[provider-outcome-unknown-no-resend] ${errMsg}` : errMsg
    await recordFailure(campaignId, recipient, personalizedMsg, detail, unknownOutcome)
    if (skip) {
      await query(
        `UPDATE campaign_recipients SET status = 'skipped', locked_at = NULL, updated_at = NOW() WHERE id = $1`,
        [recipient.id],
      )
    }
    clog.warn({
      event: skip ? 'recipient.skipped' : 'recipient.failed', campaignId, mode: 'single-line',
      recipientId: recipient.id, contactId: recipient.contact_id,
      attempt: recipient.attempts, provider: line.line_type ?? 'evolution', error: detail,
    })
    return skip ? 'skipped' : 'failed'
  }

  // Provider acceptance is final. Persistence failures must never call recordFailure
  // or remove the queued fence, because doing so would authorize a duplicate send.
  const logWriteError = (e: unknown) => clog.error({
    event: 'sent.persistence.error', campaignId, mode: 'single-line',
    recipientId: recipient.id, error: e instanceof Error ? e.message : String(e),
  })
  await query(
    `UPDATE whatsapp_messages
     SET status = 'sent', evolution_message_id = $1, sent_at = NOW(), updated_at = NOW()
     WHERE campaign_recipient_id = $2 AND status = 'queued'`,
    [messageId, recipient.id],
  ).catch(logWriteError)
  await query(
    `INSERT INTO whatsapp_messages
       (contact_id, campaign_id, phone_number, message_body, direction, status,
        evolution_message_id, sent_at, campaign_recipient_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'outbound', 'sent', $5, NOW(), $6, NOW(), NOW())
     ON CONFLICT (campaign_recipient_id)
       WHERE campaign_recipient_id IS NOT NULL
     DO UPDATE SET
       status = CASE WHEN whatsapp_messages.status IN ('delivered','read') THEN whatsapp_messages.status ELSE 'sent' END,
       evolution_message_id = COALESCE(whatsapp_messages.evolution_message_id, EXCLUDED.evolution_message_id),
       sent_at = COALESCE(whatsapp_messages.sent_at, EXCLUDED.sent_at),
       error_detail = NULL, failed_at = NULL, updated_at = NOW()`,
    [recipient.contact_id, campaignId, recipient.phone_number, personalizedMsg, messageId, recipient.id],
  ).catch(logWriteError)
  await query(
    `UPDATE campaign_recipients
     SET status = 'sent', sent_at = NOW(), locked_at = NULL,
         message_body = $1, evolution_message_id = $2,
         error_detail = NULL, failed_at = NULL, line_id = $4, updated_at = NOW()
     WHERE id = $3`,
    [personalizedMsg, messageId, recipient.id, line.id],
  ).catch(logWriteError)
  await query(
    `SELECT increment_line_counters($1)`,
    [line.id],
  ).catch(logWriteError)
  clog.info({
    event: 'recipient.sent', campaignId, mode: 'single-line',
    recipientId: recipient.id, contactId: recipient.contact_id,
    phone: recipient.phone_number.slice(-4).padStart(recipient.phone_number.length, '*'),
    attempt: recipient.attempts, provider: line.line_type ?? 'evolution',
    lineInstance: line.evolution_instance,
  })
  return 'sent'
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
      let current: { status: string } | undefined
      try {
        const [row] = await query<{ status: string }>(
          'SELECT status FROM campaigns WHERE id = $1', [id]
        )
        current = row
      } catch (statusErr) {
        clog.warn({
          event: 'status.gate.error', campaignId: id, mode: 'single-line',
          error: statusErr instanceof Error ? statusErr.message : String(statusErr),
        })
        continue
      }
      if (!current || current.status !== 'running') {
        clog.info({
          event: 'processor.stopped', campaignId: id, mode: 'single-line',
          reason: 'status-gate', status: current?.status ?? 'not-found',
        })
        break
      }

      // ── 2. Claim one recipient ──────────────────────────────────────────
      let recipient: Awaited<ReturnType<typeof claimOne>>
      try {
        let lines = await getEligibleLines(campaign.owned_by)
        if (campaign.message_type === 'template') {
          lines = lines.filter(line => line.line_type === 'cloud' && line.waba_id === campaign.template_waba_id)
        }
        await prepareCampaignRouting(id, lines.map(line => line.id))
        recipient = await claimOne(id, lines.map(line => line.id))
      } catch (claimErr) {
        clog.error({
          event: 'claim.one.error', campaignId: id, mode: 'single-line',
          error: claimErr instanceof Error ? claimErr.message : String(claimErr),
        })
        continue
      }
      if (!recipient) {
        const { pending } = await syncCounters(id)
        if (pending > 0) await query(`UPDATE campaigns SET status='paused', pause_reason='assigned_line_unavailable'
          WHERE id=$1 AND status='running'`, [id])
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
        try {
          const { pending: pendingAfterSkip } = await syncCounters(id)
          if (pendingAfterSkip === 0) break
        } catch (syncErr) {
          clog.warn({
            event: 'sync.counters.error', campaignId: id, mode: 'single-line',
            error: syncErr instanceof Error ? syncErr.message : String(syncErr),
          })
        }
        continue  // no antiblock delay for skipped recipients
      }

      // ── 4. Send ─────────────────────────────────────────────────────────
      const outcome = await sendOne(id, campaign, recipient)
      if (outcome === 'deferred') {
        await query(
          `UPDATE campaigns SET status = 'paused', pause_reason='assigned_line_unavailable', updated_at = NOW()
           WHERE id = $1 AND status = 'running'`,
          [id],
        )
        break
      }
      sendCount++

      // ── 5. Sync counters ────────────────────────────────────────────────
      try {
        const { pending } = await syncCounters(id)
        if (pending === 0) break
      } catch (syncErr) {
        clog.warn({
          event: 'sync.counters.error', campaignId: id, mode: 'single-line',
          error: syncErr instanceof Error ? syncErr.message : String(syncErr),
        })
      }

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

    // Final counter sync + completion check.
    // Wrapeado en try/catch: errores aquí no deben propagar como systemic_error.
    // La campaña ya terminó de enviar — el lock se libera en el finally independientemente.
    try {
      const { sent, failed, skipped, pending } = await syncCounters(id)
      const [finalState] = await query<{ status: string }>(
        'SELECT status FROM campaigns WHERE id = $1', [id]
      ).catch(() => [undefined] as const)

      if (finalState?.status === 'running' && pending === 0) {
        await query(
          `UPDATE campaigns SET status = 'completed', completed_at = NOW() WHERE id = $1`, [id]
        ).catch(e =>
          clog.error({
            event: 'completion.update.error', campaignId: id, mode: 'single-line',
            error: e instanceof Error ? e.message : String(e),
          })
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
    } catch (finalErr) {
      clog.error({
        event: 'processor.final.sync.error', campaignId: id, mode: 'single-line',
        error: finalErr instanceof Error ? finalErr.message : String(finalErr),
        detail: 'error en tramo final — la campaña puede necesitar completarse manualmente',
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
