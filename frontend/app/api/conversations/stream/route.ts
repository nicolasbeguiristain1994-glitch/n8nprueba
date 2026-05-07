import { NextRequest } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { sseEmitter } from '@/lib/sse-events'
import { query } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const err = await checkPermission(req, 'conversations', 'read')
  if (err) return err

  const encoder  = new TextEncoder()
  let lastCheck  = new Date()

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: object) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)) } catch {}
      }

      send({ type: 'connected' })

      // Instant events from notes / status / blacklist routes
      const onEmit = (e: object) => send({ type: 'update', ...e })
      sseEmitter.on('update', onEmit)

      // Poll for new webhook messages (3s — webhook route not modified)
      const pollTimer = setInterval(async () => {
        try {
          const rows = await query<{ has_new: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM whatsapp_messages WHERE created_at > $1) AS has_new`,
            [lastCheck.toISOString()]
          )
          if (rows[0]?.has_new) {
            lastCheck = new Date()
            send({ type: 'update', source: 'message' })
          }
        } catch {}
      }, 3000)

      // Keep-alive
      const pingTimer = setInterval(() => send({ type: 'ping' }), 25_000)

      req.signal.addEventListener('abort', () => {
        clearInterval(pollTimer)
        clearInterval(pingTimer)
        sseEmitter.off('update', onEmit)
        try { controller.close() } catch {}
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':     'text/event-stream',
      'Cache-Control':    'no-cache, no-transform',
      'Connection':       'keep-alive',
      'X-Accel-Buffering':'no',
    },
  })
}
