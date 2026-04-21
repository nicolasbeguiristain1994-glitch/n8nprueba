import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

type LogEntry = {
  phone_number:         string
  message_body:         string
  status:               'sent' | 'failed'
  evolution_message_id: string
  campaign_id:          string
  error_detail:         string
}

export async function POST(req: NextRequest) {
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
  const logs: LogEntry[] = []

  // Send sequentially (antiblock) — collect results in memory
  for (const phone of phones) {
    try {
      const res = await fetch(`${N8N_URL}/webhook/send-whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, message, campaign_id, media_url, media_type, source: 'dashboard' }),
      })

      if (res.ok) {
        let evolutionMsgId: string | null = null
        let data: Record<string, unknown> = {}
        try {
          data = await res.json()
          evolutionMsgId = (data?.key as Record<string, unknown>)?.id as string
            || data?.id as string
            || null
        } catch { /* empty body */ }

        logs.push({
          phone_number:         phone,
          message_body:         message,
          status:               'sent',
          evolution_message_id: evolutionMsgId ?? '',
          campaign_id:          campaign_id   ?? '',
          error_detail:         '',
        })
        results.push({ phone, ...data })
      } else {
        let errData: Record<string, unknown> = {}
        try { errData = await res.json() } catch { /* ignore */ }
        const errDetail = String(errData?.message || res.status)

        logs.push({
          phone_number:         phone,
          message_body:         message,
          status:               'failed',
          evolution_message_id: '',
          campaign_id:          campaign_id ?? '',
          error_detail:         errDetail,
        })
        results.push({ phone, status: 'error', error: errDetail })
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      logs.push({
        phone_number:         phone,
        message_body:         message,
        status:               'failed',
        evolution_message_id: '',
        campaign_id:          campaign_id ?? '',
        error_detail:         errMsg,
      })
      results.push({ phone, status: 'error', error: errMsg })
    }
    await new Promise(r => setTimeout(r, 200))
  }

  // Batch-insert all log rows — one query instead of N individual inserts
  if (logs.length > 0) {
    try {
      await query(
        `INSERT INTO whatsapp_messages
           (phone_number, message_body, direction, status, evolution_message_id,
            campaign_id, sent_at, failed_at, error_detail, created_at, updated_at)
         SELECT
           x.phone_number,
           x.message_body,
           'outbound',
           x.status::message_status,
           NULLIF(x.evolution_message_id, ''),
           NULLIF(x.campaign_id, '')::uuid,
           CASE WHEN x.status = 'sent'   THEN NOW() ELSE NULL END,
           CASE WHEN x.status = 'failed' THEN NOW() ELSE NULL END,
           NULLIF(x.error_detail, ''),
           NOW(), NOW()
         FROM jsonb_to_recordset($1::jsonb)
              AS x(phone_number text, message_body text, status text,
                   evolution_message_id text, campaign_id text, error_detail text)`,
        [JSON.stringify(logs)]
      )
    } catch (e) {
      console.error('[/api/send] batch log insert error:', e instanceof Error ? e.message : e)
    }
  }

  return NextResponse.json({ results, total: phones.length })
}
