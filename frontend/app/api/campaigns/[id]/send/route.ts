import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  // ── N8N_URL must exist before any DB mutation ────────────────────────────
  const N8N_URL = process.env.N8N_URL
  if (!N8N_URL) return NextResponse.json({ error: 'N8N_URL not configured' }, { status: 500 })

  // ── Fetch campaign details (read-only, no status change yet) ─────────────
  type CampaignRow = {
    id: string; name: string; message: string; messages: string[] | null; media_url: string
    list_id: string; antiblock_delay_min: number; antiblock_delay_max: number
    personalize_name: boolean; status: string
  }
  let campaign: CampaignRow | undefined

  try {
    const rows = await query<CampaignRow>('SELECT * FROM campaigns WHERE id = $1', [id])
    campaign = rows[0]
  } catch (e) {
    console.error('[campaign send] fetch campaign error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

  // If already running/completed/cancelled, reject before touching any state
  if (!['draft', 'scheduled', 'paused'].includes(campaign.status)) {
    return NextResponse.json({ error: `Campaign is already ${campaign.status}` }, { status: 409 })
  }

  // ── Fetch eligible contacts (read-only, no status change yet) ───────────
  let contacts: Array<{ phone_number: string; first_name: string; id: string }> = []
  try {
    contacts = await query<{ phone_number: string; first_name: string; id: string }>(
      `SELECT c.phone_number, c.first_name, c.id
       FROM contacts c
       JOIN contact_list_members clm ON clm.contact_id = c.id
       WHERE clm.list_id = $1
         AND c.opt_in_marketing = true
         AND c.do_not_contact = false
         AND c.status = 'active'`,
      [campaign.list_id]
    )
  } catch (e) {
    console.error('[campaign send] fetch contacts error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  // Validate before mutating — campaign stays in current status on failure
  if (!contacts.length) return NextResponse.json({ error: 'No contacts in list' }, { status: 400 })

  // ── Atomic status transition — NOW safe to mutate ────────────────────────
  // Only transitions draft/scheduled/paused → running. Guards concurrent double-clicks.
  let campaignRow: { id: string } | undefined
  try {
    const rows = await query<{ id: string }>(
      `UPDATE campaigns
       SET status = 'running', started_at = COALESCE(started_at, NOW())
       WHERE id = $1 AND status IN ('draft', 'scheduled', 'paused')
       RETURNING id`,
      [id]
    )
    campaignRow = rows[0]
  } catch (e) {
    console.error('[campaign send] status update error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  if (!campaignRow) {
    // Lost the race — another request transitioned status between our read and this UPDATE
    return NextResponse.json({ error: `Campaign is already ${campaign.status}` }, { status: 409 })
  }

  // ── Populate campaign_recipients (idempotent — ON CONFLICT DO NOTHING) ───
  try {
    await query(
      `INSERT INTO campaign_recipients (campaign_id, contact_id, phone_number)
       SELECT $1, c.id, c.phone_number
       FROM contacts c
       JOIN contact_list_members clm ON clm.contact_id = c.id
       WHERE clm.list_id = $2
         AND c.opt_in_marketing = true
         AND c.do_not_contact = false
         AND c.status = 'active'
       ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
      [id, campaign.list_id]
    )
  } catch (e) {
    console.error('[campaign send] populate recipients error:', e instanceof Error ? e.message : e)
    // Non-fatal: log and continue — send still works without recipient tracking
  }

  // Update total_targets from actual contact count
  try {
    await query(
      `UPDATE campaigns SET total_targets = $1 WHERE id = $2`,
      [contacts.length, id]
    )
  } catch (e) {
    console.error('[campaign send] update total_targets error:', e instanceof Error ? e.message : e)
    // Non-fatal: cosmetic counter
  }

  // ── Send in background — respond immediately ─────────────────────────────
  ;(async () => {
    // On resume: seed counters from persisted state so totals stay accurate
    let sent = 0, failed = 0
    try {
      const [counts] = await query<{ sent_count: string; failed_count: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'sent')   AS sent_count,
           COUNT(*) FILTER (WHERE status = 'failed') AS failed_count
         FROM campaign_recipients
         WHERE campaign_id = $1`,
        [id]
      )
      sent   = Number(counts?.sent_count   || 0)
      failed = Number(counts?.failed_count || 0)
    } catch { /* campaign_recipients unavailable — start at 0 */ }

    for (const contact of contacts) {
      // Check for pause/cancel before each message
      const [current] = await query<{ status: string }>('SELECT status FROM campaigns WHERE id = $1', [id])
      if (current?.status === 'paused' || current?.status === 'cancelled') break

      // Skip if already sent in a previous run — do NOT increment sent (already counted in seed)
      try {
        const [existing] = await query<{ status: string }>(
          `SELECT status FROM campaign_recipients WHERE campaign_id = $1 AND contact_id = $2`,
          [id, contact.id]
        )
        if (existing?.status === 'sent') {
          continue  // already counted in seeded `sent` value — do not double-count
        }
      } catch { /* non-fatal: recipient tracking is best-effort */ }

      // Pick a random message variant
      const msgPool = Array.isArray(campaign!.messages) && campaign!.messages.length > 0
        ? campaign!.messages
        : [campaign!.message]
      const rawMsg = msgPool[Math.floor(Math.random() * msgPool.length)]

      const nameValue = campaign!.personalize_name !== false ? (contact.first_name || '') : ''
      const personalizedMsg = rawMsg
        .replace(/\{\{nombre\}\}/gi, nameValue)
        .replace(/\{\{name\}\}/gi, nameValue)

      try {
        const res = await fetch(`${N8N_URL}/webhook/send-whatsapp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone: contact.phone_number,
            message: personalizedMsg,
            campaign_id: id,
            campaign_name: campaign!.name,
            contact_id: contact.id,
            media_url: campaign!.media_url || undefined,
            source: 'campaign',
            antiblock_delay_min: campaign!.antiblock_delay_min,
            antiblock_delay_max: campaign!.antiblock_delay_max,
          }),
        })

        if (res.ok) {
          sent++
          let evolutionMsgId: string | null = null
          try {
            const responseData = await res.json()
            evolutionMsgId = responseData?.key?.id || responseData?.id || null
          } catch { /* n8n respondió con body vacío */ }

          await query(
            `INSERT INTO whatsapp_messages
               (contact_id, campaign_id, phone_number, message_body, direction, status,
                evolution_message_id, sent_at, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 'outbound', 'sent', $5, NOW(), NOW(), NOW())`,
            [contact.id, id, contact.phone_number, personalizedMsg, evolutionMsgId]
          )

          try {
            await query(
              `UPDATE campaign_recipients
               SET status = 'sent', sent_at = NOW(), message_body = $1,
                   evolution_message_id = $2, updated_at = NOW()
               WHERE campaign_id = $3 AND contact_id = $4`,
              [personalizedMsg, evolutionMsgId, id, contact.id]
            )
          } catch { /* non-fatal: recipient tracking is best-effort */ }
        } else {
          let errDetail: string | number = res.status
          try { const d = await res.json(); errDetail = d?.message || res.status } catch { /* ignore */ }
          console.error(`[campaign ${id}] Error ${errDetail} para ${contact.phone_number}`)
          failed++

          await query(
            `INSERT INTO whatsapp_messages
               (contact_id, campaign_id, phone_number, message_body, direction, status,
                failed_at, error_detail, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 'outbound', 'failed', NOW(), $5, NOW(), NOW())`,
            [contact.id, id, contact.phone_number, personalizedMsg, String(errDetail)]
          )

          try {
            await query(
              `UPDATE campaign_recipients
               SET status = 'failed', failed_at = NOW(), error_detail = $1,
                   attempts = attempts + 1, updated_at = NOW()
               WHERE campaign_id = $2 AND contact_id = $3`,
              [String(errDetail), id, contact.id]
            )
          } catch { /* non-fatal: recipient tracking is best-effort */ }
        }
      } catch (e) {
        console.error(`[campaign ${id}] Excepción para ${contact.phone_number}:`, e instanceof Error ? e.message : e)
        failed++
        const errMsg = e instanceof Error ? e.message : 'network error'
        await query(
          `INSERT INTO whatsapp_messages
             (contact_id, campaign_id, phone_number, message_body, direction, status,
              failed_at, error_detail, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'outbound', 'failed', NOW(), $5, NOW(), NOW())`,
          [contact.id, id, contact.phone_number, personalizedMsg, errMsg]
        )
        try {
          await query(
            `UPDATE campaign_recipients
             SET status = 'failed', failed_at = NOW(), error_detail = $1,
                 attempts = attempts + 1, updated_at = NOW()
             WHERE campaign_id = $2 AND contact_id = $3`,
            [errMsg, id, contact.id]
          )
        } catch { /* non-fatal: recipient tracking is best-effort */ }
      }

      // Update progress counters in DB after each message
      await query(
        `UPDATE campaigns SET total_sent = $1, total_failed = $2 WHERE id = $3`,
        [sent, failed, id]
      )

      // Antiblock delay between messages (skip on last)
      const isLast = contact === contacts[contacts.length - 1]
      if (!isLast) {
        const delaySec = Math.floor(
          Math.random() * (campaign!.antiblock_delay_max - campaign!.antiblock_delay_min + 1)
        ) + campaign!.antiblock_delay_min
        await new Promise(r => setTimeout(r, delaySec * 1000))
      }
    }

    // Only mark completed if not paused/cancelled
    const [finalState] = await query<{ status: string }>('SELECT status FROM campaigns WHERE id = $1', [id])
    if (finalState?.status === 'running') {
      await query(`UPDATE campaigns SET status = 'completed', completed_at = NOW() WHERE id = $1`, [id])
    }
  })()

  return NextResponse.json({ started: true, total: contacts.length })
}
