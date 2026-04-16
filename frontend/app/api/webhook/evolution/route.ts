import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

// Evolution API v2 webhook handler
// Handles: messages.upsert (inbound) + messages.update (status updates)

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const event = body.event as string
  const data  = body.data as Record<string, unknown>

  // ── Mensaje entrante ──────────────────────────────────────────────
  if (event === 'messages.upsert') {
    const key     = data.key as Record<string, unknown>
    const fromMe  = key?.fromMe as boolean
    const jid     = (key?.remoteJid as string) || ''
    const msgId   = (key?.id as string) || ''

    // Ignorar mensajes propios y mensajes de grupos
    if (fromMe || jid.endsWith('@g.us')) return NextResponse.json({ ok: true })

    const phone = jid.replace('@s.whatsapp.net', '')

    // Extraer texto del mensaje (distintos tipos)
    const msg = data.message as Record<string, unknown> | null
    const body_text =
      (msg?.conversation as string) ||
      (msg?.extendedTextMessage as Record<string,unknown>)?.text as string ||
      (msg?.imageMessage as Record<string,unknown>)?.caption as string ||
      (msg?.videoMessage as Record<string,unknown>)?.caption as string ||
      '[media]'

    const ts = data.messageTimestamp as number
    const sent_at = ts ? new Date(ts * 1000).toISOString() : new Date().toISOString()

    // Evitar duplicados por evolution_message_id
    const existing = await query(
      `SELECT id FROM whatsapp_messages WHERE evolution_message_id = $1`,
      [msgId]
    )
    if (existing.length > 0) return NextResponse.json({ ok: true })

    await query(
      `INSERT INTO whatsapp_messages
         (phone_number, message_body, direction, status, evolution_message_id, created_at)
       VALUES ($1, $2, 'inbound', 'received', $3, $4)`,
      [phone, body_text, msgId, sent_at]
    )

    return NextResponse.json({ ok: true })
  }

  // ── Actualización de estado (enviado → entregado → leído) ─────────
  if (event === 'messages.update') {
    const updates = Array.isArray(data) ? data : [data]

    for (const upd of updates) {
      const u      = upd as Record<string, unknown>
      const key    = u.key as Record<string, unknown>
      const msgId  = key?.id as string
      const raw    = (u.update as Record<string, unknown>)?.status

      if (!msgId || raw === undefined) continue

      // Evolution puede enviar número (0-5) o string
      let status = 'sent'
      const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10)
      if (!isNaN(n)) {
        if (n >= 4) status = 'read'
        else if (n === 3) status = 'delivered'
        else if (n === 2) status = 'sent'
      } else {
        const s = String(raw).toUpperCase()
        if (s === 'READ') status = 'read'
        else if (s === 'DELIVERED') status = 'delivered'
        else if (s === 'SENT') status = 'sent'
        else if (s === 'FAILED' || s === 'ERROR') status = 'failed'
      }

      await query(
        `UPDATE whatsapp_messages
         SET status       = $1,
             delivered_at = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END,
             read_at      = CASE WHEN $1 = 'read'      THEN NOW() ELSE read_at END,
             failed_at    = CASE WHEN $1 = 'failed'    THEN NOW() ELSE failed_at END,
             updated_at   = NOW()
         WHERE evolution_message_id = $2`,
        [status, msgId]
      )
    }

    return NextResponse.json({ ok: true })
  }

  // Otros eventos ignorados
  return NextResponse.json({ ok: true })
}
