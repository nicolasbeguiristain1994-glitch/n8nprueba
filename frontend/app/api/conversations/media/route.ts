import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { getAccessibleLineIds } from '@/lib/line-visibility'
import { scopedConversationMessages } from '@/lib/conversation-messages'
import { CONVERSATION_MEDIA_JOIN, conversationMediaUrl, type ConversationMediaRow } from '@/lib/conversation-media'
import { getTokenForNumber } from '@/lib/cloud-api/token-store'
import { downloadInboundMedia, MediaUnavailableError } from '@/lib/cloud-api/infrastructure/inbound-media'

const privateHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'conversations', 'read')
  if (!auth.ok) return auth.response
  const id = req.nextUrl.searchParams.get('message') || ''
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: 'Mensaje inválido' }, { status: 400, headers: privateHeaders })
  }
  try {
    const lineIds = await getAccessibleLineIds(auth.user)
    const scope = scopedConversationMessages(auth.user, 2)
    const [media] = await query<ConversationMediaRow>(`
      ${scope.sql}
      SELECT media.* FROM conversation_messages recent
      ${CONVERSATION_MEDIA_JOIN}
      WHERE recent.id=$2::uuid
    `, [lineIds, id, ...scope.params])
    if (!media || !conversationMediaUrl(id, media.media_id)) {
      return NextResponse.json({ error: 'Archivo no disponible' }, { status: 404, headers: privateHeaders })
    }
    // Authorization precedes credential lookup and every provider request.
    const token = await getTokenForNumber(media.phone_number_id)
    const { bytes, mime } = await downloadInboundMedia(media.media_id!, media.phone_number_id, token)
    return new NextResponse(new Uint8Array(bytes), { headers: {
      ...privateHeaders, 'Content-Type': mime, 'Content-Length': String(bytes.length),
      'Content-Disposition': 'inline', 'Cross-Origin-Resource-Policy': 'same-origin',
    } })
  } catch (error) {
    // Do not log signed URLs, provider responses, tokens or private image bytes.
    const unavailable = error instanceof MediaUnavailableError
    if (!unavailable) console.error('[/api/conversations/media] Could not retrieve media')
    return NextResponse.json({ error: unavailable ? error.message : 'No se pudo cargar el archivo. Reintentá.' },
      { status: unavailable ? 410 : 502, headers: privateHeaders })
  }
}
