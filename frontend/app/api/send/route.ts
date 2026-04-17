import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function POST(req: NextRequest) {
  // ── Fix 5: server-only N8N_URL ──────────────────────────────────────────
  const N8N_URL = process.env.N8N_URL
  if (!N8N_URL) return NextResponse.json({ error: 'N8N_URL not configured' }, { status: 500 })

  let body: { phones?: string[]; message?: string; campaign_id?: string; media_url?: string; media_type?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { phones, message, campaign_id, media_url, media_type } = body

  if (!phones?.length || !message) {
    return NextResponse.json({ error: 'phones y message son requeridos' }, { status: 400 })
  }

  const results = []
  for (const phone of phones) {
    try {
      const res = await fetch(`${N8N_URL}/webhook/send-whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, message, campaign_id, media_url, media_type, source: 'dashboard' }),
      })

      // ── Fix 6: log outbound messages ──────────────────────────────────────
      if (res.ok) {
        let evolutionMsgId: string | null = null
        let data: Record<string, unknown> = {}
        try {
          data = await res.json()
          evolutionMsgId = (data?.key as Record<string, unknown>)?.id as string
            || data?.id as string
            || null
        } catch { /* empty body */ }

        try {
          await query(
            `INSERT INTO whatsapp_messages
               (phone_number, message_body, direction, status, evolution_message_id,
                campaign_id, sent_at, created_at, updated_at)
             VALUES ($1, $2, 'outbound', 'sent', $3, $4, NOW(), NOW(), NOW())`,
            [phone, message, evolutionMsgId, campaign_id || null]
          )
        } catch (dbErr) {
          console.error('[/api/send] DB insert error:', dbErr instanceof Error ? dbErr.message : dbErr)
        }

        results.push({ phone, ...data })
      } else {
        let errData: Record<string, unknown> = {}
        try { errData = await res.json() } catch { /* ignore */ }

        // Log failed outbound message
        try {
          await query(
            `INSERT INTO whatsapp_messages
               (phone_number, message_body, direction, status,
                campaign_id, failed_at, error_detail, created_at, updated_at)
             VALUES ($1, $2, 'outbound', 'failed', $3, NOW(), $4, NOW(), NOW())`,
            [phone, message, campaign_id || null, String(errData?.message || res.status)]
          )
        } catch (dbErr) {
          console.error('[/api/send] DB insert failed row error:', dbErr instanceof Error ? dbErr.message : dbErr)
        }

        results.push({ phone, status: 'error', error: errData?.message || res.status })
      }
    } catch (e) {
      // Log network-level failure
      const errMsg = e instanceof Error ? e.message : String(e)
      try {
        await query(
          `INSERT INTO whatsapp_messages
             (phone_number, message_body, direction, status,
              campaign_id, failed_at, error_detail, created_at, updated_at)
           VALUES ($1, $2, 'outbound', 'failed', $3, NOW(), $4, NOW(), NOW())`,
          [phone, message, campaign_id || null, errMsg]
        )
      } catch (dbErr) {
        console.error('[/api/send] DB insert exception row error:', dbErr instanceof Error ? dbErr.message : dbErr)
      }
      results.push({ phone, status: 'error', error: errMsg })
    }
    // Pausa entre envíos
    await new Promise(r => setTimeout(r, 200))
  }

  return NextResponse.json({ results, total: phones.length })
}
