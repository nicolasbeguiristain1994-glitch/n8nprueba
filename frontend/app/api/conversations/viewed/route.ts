import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { getAccessibleLineIds } from '@/lib/line-visibility'
import { scopedConversationMessages } from '@/lib/conversation-messages'
import { sseEmitter } from '@/lib/sse-events'

const schema = z.object({ messageId: z.uuid() }).strict()

// Shared inbox acknowledgement, not a WhatsApp delivery/read receipt. Only the
// exact message displayed is acknowledged, so a concurrent arrival stays pending.
export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'conversations', 'read')
  if (!auth.ok) return auth.response
  const parsed = schema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Mensaje inválido.' }, { status: 400 })
  try {
    const scope = scopedConversationMessages(auth.user, 2)
    const [result] = await query<{ message_key: string; phone: string; inserted: boolean }>(`${scope.sql}, target AS (
      SELECT COALESCE(NULLIF(evolution_message_id,''),id::text) AS message_key,
        REPLACE(phone_number,'+','') AS phone
      FROM conversation_messages WHERE id=$2::uuid AND direction='inbound'
    ), saved AS (
      INSERT INTO conversation_message_views(message_key)
      SELECT message_key FROM target ON CONFLICT(message_key) DO NOTHING RETURNING message_key
    ) SELECT target.*, EXISTS(SELECT 1 FROM saved) AS inserted FROM target`,
    [await getAccessibleLineIds(auth.user), parsed.data.messageId, ...scope.params])
    if (!result) return NextResponse.json({ error: 'Mensaje no disponible.' }, { status: 404 })
    if (result.inserted) sseEmitter.emit('update', { source: 'viewed', phone: result.phone })
    return NextResponse.json({ ok: true, message_key: result.message_key }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return NextResponse.json({ error: 'No se pudo marcar la conversación como vista.' }, { status: 500 })
  }
}
