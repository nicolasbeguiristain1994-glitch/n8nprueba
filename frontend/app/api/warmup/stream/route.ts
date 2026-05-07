import { NextRequest } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { warmupSseEmitter } from '@/lib/warmup-sse'
import { query } from '@/lib/db'

export const dynamic = 'force-dynamic'

const WARMUP_QUERY = `
  SELECT w.id, w.phone_number, w.instance_name, w.display_name, w.warmup_status,
         w.current_day, w.target_days, w.messages_sent_today, w.daily_limit,
         w.last_message_at, w.start_date, w.notes,
         COALESCE(w.delay_preset, 'normal') AS delay_preset,
         COALESCE(l.total_sent, 0)::int AS total_messages_sent
  FROM warmup_numbers w
  LEFT JOIN (
    SELECT warmup_number_id, COUNT(*) AS total_sent
    FROM warmup_activity_log WHERE status = 'sent'
    GROUP BY warmup_number_id
  ) l ON l.warmup_number_id = w.id
  ORDER BY w.created_at DESC
`

export async function GET(req: NextRequest) {
  const err = await checkPermission(req, 'warmup', 'read')
  if (err) return err

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      let closed = false

      const send = (data: object) => {
        if (closed) return
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)) } catch {}
      }

      const fetchAndSend = async () => {
        try {
          const numbers = await query(WARMUP_QUERY)
          send({ type: 'warmup-update', numbers })
        } catch {}
      }

      send({ type: 'connected' })
      fetchAndSend()

      // Poll every 15s as fallback (catches cron-driven updates)
      const pollTimer = setInterval(fetchAndSend, 15_000)

      // Instant push on any mutation (PATCH / POST / DELETE / reset)
      warmupSseEmitter.on('warmup-change', fetchAndSend)

      // Keep-alive
      const pingTimer = setInterval(() => send({ type: 'ping' }), 25_000)

      req.signal.addEventListener('abort', () => {
        closed = true
        clearInterval(pollTimer)
        clearInterval(pingTimer)
        warmupSseEmitter.off('warmup-change', fetchAndSend)
        try { controller.close() } catch {}
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
