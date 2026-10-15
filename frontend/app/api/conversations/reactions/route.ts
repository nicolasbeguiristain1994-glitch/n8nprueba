import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { query, withTransaction } from '@/lib/db'
import { canAccess, checkPermissionWithUser } from '@/lib/permissions'
import { getAccessibleLineIds } from '@/lib/line-visibility'
import { scopedConversationMessages } from '@/lib/conversation-messages'
import { REACTION_TARGET_JOIN } from '@/lib/conversation-reactions'
import { isReactionEmoji, reactionUnavailable } from '@/lib/message-reactions'
import { sendMessageReaction, type ReactionTarget } from '@/lib/send-message-reaction'
import { CloudSendOutcomeUnknownError } from '@/lib/campaign-distributor'
import { CloudApiError, ConversationWindowError, OptOutError } from '@/lib/cloud-api/errors'
import { sseEmitter } from '@/lib/sse-events'
import { audit } from '@/lib/audit'

const schema = z.object({ messageId: z.uuid(), requestId: z.uuid(), emoji: z.string().max(64).refine(isReactionEmoji) }).strict()
const uncertain = 'No se pudo confirmar la reacción. Revisá WhatsApp antes de volver a intentarlo.'

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'conversations', 'read')
  if (!auth.ok) return auth.response
  if (!canAccess(auth.user, 'send', 'send')) return NextResponse.json({ error: 'Sin permiso para enviar reacciones.' }, { status: 403 })
  const parsed = schema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Elegí un emoji válido para este mensaje.' }, { status: 400 })
  const { messageId, requestId, emoji } = parsed.data
  let claimed = false
  let accepted = false
  try {
    const lines = await getAccessibleLineIds(auth.user)
    const scope = scopedConversationMessages(auth.user, 2)
    const [target] = await query<ReactionTarget>(`${scope.sql}
      SELECT recent.*,reaction_target.* FROM conversation_messages recent
      ${REACTION_TARGET_JOIN} WHERE recent.id=$2::uuid`, [lines, messageId, ...scope.params])
    if (!target?.line_id) return NextResponse.json({ error: 'Mensaje no disponible para reaccionar.' }, { status: 404 })
    const reason = reactionUnavailable(target)
    if (reason) return NextResponse.json({ error: reason }, { status: 409 })

    // A durable request ID fences double clicks and repeated HTTP requests.
    const metadata = { kind: 'reaction', target_wamid: target.target_wamid, line_id: target.line_id, emoji,
      target_message_id: messageId, sent_by_user_id: auth.user.user_id }
    const inserted = await query(`INSERT INTO whatsapp_messages
      (id,phone_number,message_body,direction,status,sent_at,metadata)
      VALUES($1,$2,'[Reacción]','outbound','queued',NULL,$3::jsonb)
      ON CONFLICT(id) DO NOTHING RETURNING id`, [requestId, target.phone_number, JSON.stringify(metadata)])
    if (!inserted.length) {
      const [previous] = await query<{ status: string; metadata: typeof metadata }>(
        'SELECT status,metadata FROM whatsapp_messages WHERE id=$1', [requestId])
      if (previous?.metadata?.target_message_id !== messageId || previous.metadata.emoji !== emoji
        || previous.metadata.sent_by_user_id !== auth.user.user_id) {
        return NextResponse.json({ error: 'Solicitud de reacción inválida.' }, { status: 409 })
      }
      return ['sent', 'delivered', 'read'].includes(previous.status)
        ? NextResponse.json({ ok: true })
        : NextResponse.json({ error: previous.status === 'queued' ? uncertain : 'La reacción anterior falló.' }, { status: 409 })
    }
    claimed = true
    const result = await sendMessageReaction(target, emoji)
    accepted = true
    await withTransaction(async client => {
      // Evolution can echo the accepted event before the HTTP response arrives.
      // Retain the request fence, but project only the provider's unique event.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['reaction-event:'+result.messageId])
      const existing = await client.query<{id:string;metadata:typeof metadata}>(
        'SELECT id,metadata FROM whatsapp_messages WHERE evolution_message_id=$1', [result.messageId])
      const echo = existing.rows[0]
      if (echo && (echo.metadata?.kind!=='reaction' || echo.metadata.target_wamid!==target.target_wamid
        || echo.metadata.line_id!==target.line_id || echo.metadata.emoji!==emoji)) throw new CloudSendOutcomeUnknownError()
      await client.query(`UPDATE whatsapp_messages SET evolution_message_id=$2,status='sent',sent_at=NOW(),updated_at=NOW(),
        metadata=metadata || $3::jsonb WHERE id=$1 AND status='queued'`,
        [requestId,echo ? null : result.messageId,JSON.stringify(echo ? {duplicate_of:echo.id} : {})])
    })
    sseEmitter.emit('update', { source: 'reaction', phone: target.phone_number })
    void audit({ req, action: 'send', resource: 'conversations', metadata: { message_id: messageId, reaction: emoji, line_id: target.line_id } })
    return NextResponse.json({ ok: true })
  } catch (error) {
    const unknown = accepted || error instanceof CloudSendOutcomeUnknownError
    const detail = unknown ? uncertain
      : error instanceof ConversationWindowError ? 'La ventana de 24 horas de esta línea está cerrada. Esperá un nuevo mensaje del contacto para reaccionar.'
      : error instanceof OptOutError ? 'El contacto está dado de baja y no admite envíos.'
      : error instanceof CloudApiError ? error.message : 'No se pudo enviar la reacción.'
    if (claimed && !unknown) await query(`UPDATE whatsapp_messages SET status='failed',error_detail=$2,failed_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND status='queued'`, [requestId, detail]).catch(() => {})
    return NextResponse.json({ error: detail }, { status: unknown ? 503 : error instanceof CloudApiError ? 409 : 500 })
  }
}
