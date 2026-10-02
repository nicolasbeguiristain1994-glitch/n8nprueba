import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser, isCampaignOwnerOrAdmin } from '@/lib/permissions'
import { audit } from '@/lib/audit'

const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 }
const ACK_STATUS: Record<string, string> = {
  SERVER_ACK: 'sent', DELIVERY_ACK: 'delivered', READ: 'read', PLAYED: 'read',
}

// ACK lookups use the Evolution line recorded for each recipient. Cloud ACKs
// arrive through their signed webhook; missing line evidence is skipped.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'update')
  if (!auth.ok) return auth.response
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  try {
    const [campaign] = await query<{ owned_by: string | null }>(
      'SELECT owned_by FROM campaigns WHERE id = $1', [id])
    if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    if (!isCampaignOwnerOrAdmin(auth.user, campaign.owned_by))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const apiKey = process.env.EVOLUTION_GLOBAL_API_KEY || process.env.EVOLUTION_API_KEY
    if (!apiKey) return NextResponse.json({ error: 'Evolution not configured' }, { status: 500 })
    const messages = await query<{
      id: string; evolution_message_id: string; status: string;
      evolution_instance: string | null; evolution_url: string | null; line_type: string | null
    }>(`SELECT wm.id, wm.evolution_message_id, wm.status,
               wl.evolution_instance, wl.evolution_url, wl.line_type
        FROM whatsapp_messages wm
        LEFT JOIN campaign_recipients cr ON cr.id = wm.campaign_recipient_id AND cr.campaign_id = wm.campaign_id
        LEFT JOIN whatsapp_lines wl ON wl.id = cr.line_id
        WHERE wm.campaign_id = $1 AND wm.direction = 'outbound'
          AND wm.evolution_message_id IS NOT NULL AND wm.status IN ('queued', 'sent', 'delivered')
        ORDER BY wm.sent_at DESC NULLS LAST LIMIT 100`, [id])

    let synced = 0, skipped = 0
    for (const msg of messages) {
      const evoUrl = msg.evolution_url || process.env.EVOLUTION_URL
      if (!msg.evolution_instance || msg.line_type === 'cloud' || !evoUrl) { skipped++; continue }
      try {
        const res = await fetch(`${evoUrl.replace(/\/$/, '')}/chat/findMessages/${encodeURIComponent(msg.evolution_instance)}`, {
          method: 'POST', headers: { apikey: apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ where: { key: { id: msg.evolution_message_id } } }),
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) continue
        const data = await res.json()
        const records = data?.messages?.records
        if (!Array.isArray(records)) continue
        const record = records.find((row: { key?: { id?: string } }) => row?.key?.id === msg.evolution_message_id)
        if (!Array.isArray(record?.MessageUpdate)) continue
        let nextStatus = msg.status
        for (const update of record.MessageUpdate) {
          const mapped = ACK_STATUS[update?.status]
          if (mapped && RANK[mapped] > (RANK[nextStatus] ?? -1)) nextStatus = mapped
        }
        if (nextStatus === msg.status) continue
        const updated = await query<{ id: string }>(
          `UPDATE whatsapp_messages SET status = $1::message_status,
             delivered_at = CASE WHEN $1 IN ('delivered','read') THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
             read_at = CASE WHEN $1 = 'read' THEN COALESCE(read_at, NOW()) ELSE read_at END,
             updated_at = NOW()
           WHERE id = $2 AND campaign_id = $3
             AND status IN ('queued', 'sent', 'delivered')
             AND CASE status WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 ELSE 3 END < $4
           RETURNING id`, [nextStatus, msg.id, id, RANK[nextStatus]])
        synced += updated.length
      } catch { /* One unavailable provider lookup must not affect other lines. */ }
    }
    void audit({ req, action: 'update', resource: 'campaigns', resource_id: id,
      metadata: { action: 'sync_status', synced, skipped } })
    return NextResponse.json({ synced, total: messages.length, skipped })
  } catch (error) {
    console.error('[POST /campaigns/[id]/sync-status]', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
