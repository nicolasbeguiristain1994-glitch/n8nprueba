import { NextRequest } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { sseEmitter } from '@/lib/sse-events'
import { query } from '@/lib/db'
import { getAccessibleLineIds } from '@/lib/line-visibility'
import { scopedConversationMessages } from '@/lib/conversation-messages'
import { canReadConversation, conversationPhone } from '@/lib/conversation-access'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const initial = await checkPermissionWithUser(req, 'conversations', 'read')
  if (!initial.ok) return initial.response
  const encoder = new TextEncoder()
  let lastCheck = new Date()
  let stop = () => {}
  const stream = new ReadableStream({
    start(controller) {
      let closed = false
      let polling = false
      let draining = false
      const phones = new Map<string, string>()
      const send = (data: object) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }
      const fresh = async () => {
        const auth = await checkPermissionWithUser(req, 'conversations', 'read')
        if (!auth.ok) { stop(); return null }
        return auth.user
      }
      const drain = async () => {
        if (draining || closed) return
        draining = true
        try {
          while (phones.size && !closed) {
            const [phone, source] = phones.entries().next().value!
            phones.delete(phone)
            const user = await fresh()
            if (user && await canReadConversation(user, phone)) send({type: 'update', source, phone})
          }
        } catch { stop() } finally { draining = false }
      }
      const onEmit = (event: {phone?: string; type?: string; source?: string}) => {
        // Global events have no verifiable audience; scoped polling covers them.
        if (typeof event.phone !== 'string' || phones.size >= 100) return
        phones.set(conversationPhone(event.phone), event.source || event.type || 'message')
        void drain()
      }
      const pollTimer = setInterval(async () => {
        if (polling || closed) return
        polling = true
        const watermark = new Date()
        try {
          const user = await fresh()
          if (!user) return
          const scope = scopedConversationMessages(user, 2)
          const rows = await query<{has_new: boolean}>(`${scope.sql}
            SELECT EXISTS (SELECT 1 FROM conversation_messages WHERE created_at > $2) AS has_new`,
            [await getAccessibleLineIds(user), lastCheck.toISOString(), ...scope.params])
          lastCheck = watermark
          if (rows[0]?.has_new) send({type: 'update', source: 'message'})
        } catch { stop() } finally { polling = false }
      }, 3000)
      const pingTimer = setInterval(() => send({type: 'ping'}), 25_000)
      stop = () => {
        if (closed) return
        closed = true
        clearInterval(pollTimer); clearInterval(pingTimer)
        phones.clear(); sseEmitter.off('update', onEmit)
        req.signal.removeEventListener('abort', stop)
        try { controller.close() } catch {}
      }
      req.signal.addEventListener('abort', stop, {once: true})
      sseEmitter.on('update', onEmit)
      if (req.signal.aborted) stop()
      else send({type: 'connected'})
    },
    cancel() { stop() },
  })
  return new Response(stream, {headers: {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  }})
}
