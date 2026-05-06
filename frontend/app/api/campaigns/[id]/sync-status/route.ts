import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermission } from '@/lib/permissions'

/**
 * POST /api/campaigns/[id]/sync-status
 *
 * Queries Evolution's findMessages API for recent outgoing messages of this
 * campaign and updates delivered_at / read_at / status in whatsapp_messages.
 *
 * Evolution stores ACKs internally (SERVER_ACK, DELIVERY_ACK, READ) but does
 * not always fire MESSAGES_UPDATE webhooks for sent-message status changes.
 * This endpoint bridges that gap on demand.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const err = await checkPermission(req, 'campaigns', 'read')
  if (err) return err

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const apiKey = process.env.EVOLUTION_GLOBAL_API_KEY || process.env.EVOLUTION_API_KEY
  const evoUrl = process.env.EVOLUTION_URL || ''
  if (!apiKey || !evoUrl) {
    return NextResponse.json({ error: 'Evolution not configured' }, { status: 500 })
  }

  // Fetch all 'sent' outbound messages for this campaign (up to 100)
  const messages = await query<{
    id: string
    evolution_message_id: string
    phone_number: string
    status: string
  }>(
    `SELECT id, evolution_message_id, phone_number, status
     FROM whatsapp_messages
     WHERE campaign_id = $1
       AND direction = 'outbound'
       AND evolution_message_id IS NOT NULL
       AND status NOT IN ('read', 'failed')
     ORDER BY sent_at DESC
     LIMIT 100`,
    [id]
  ).catch(() => [])

  if (messages.length === 0) return NextResponse.json({ synced: 0 })

  // Fetch the eligible line to know which Evolution instance to query
  const [line] = await query<{ evolution_instance: string; evolution_url: string }>(
    `SELECT evolution_instance, COALESCE(evolution_url, $1) AS evolution_url
     FROM whatsapp_lines
     WHERE status = 'active' AND is_connected = true
     LIMIT 1`,
    [evoUrl]
  ).catch(() => [])

  if (!line) return NextResponse.json({ synced: 0, reason: 'no active line' })

  const lineEvoUrl = line.evolution_url || evoUrl

  let synced = 0
  const statusMap: Record<string, string> = {
    SERVER_ACK:   'sent',
    DELIVERY_ACK: 'delivered',
    READ:         'read',
    PLAYED:       'read',
  }

  for (const msg of messages) {
    try {
      const res = await fetch(
        `${lineEvoUrl}/chat/findMessages/${encodeURIComponent(line.evolution_instance)}`,
        {
          method:  'POST',
          headers: { apikey: apiKey, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ where: { key: { id: msg.evolution_message_id } } }),
          signal:  AbortSignal.timeout(5000),
        }
      )
      if (!res.ok) continue

      const data = await res.json()
      const records: { MessageUpdate?: { status: string }[] }[] =
        data?.messages?.records ?? []
      if (records.length === 0) continue

      const updates: { status: string }[] = records[0]?.MessageUpdate ?? []
      if (updates.length === 0) continue

      // Take the "highest" status (READ > DELIVERY_ACK > SERVER_ACK)
      const priority = ['READ', 'PLAYED', 'DELIVERY_ACK', 'SERVER_ACK']
      let bestStatus = ''
      for (const p of priority) {
        if (updates.some(u => u.status === p)) { bestStatus = p; break }
      }
      if (!bestStatus) continue

      const newStatus = statusMap[bestStatus]
      if (!newStatus || newStatus === msg.status) continue

      await query(
        `UPDATE whatsapp_messages
         SET status       = $1::message_status,
             delivered_at = CASE WHEN $1 IN ('delivered','read') AND delivered_at IS NULL THEN NOW() ELSE delivered_at END,
             read_at      = CASE WHEN $1 = 'read'                AND read_at      IS NULL THEN NOW() ELSE read_at      END,
             updated_at   = NOW()
         WHERE id = $2`,
        [newStatus, msg.id]
      )
      synced++
    } catch {
      // non-critical — best effort
    }
  }

  return NextResponse.json({ synced, total: messages.length })
}
