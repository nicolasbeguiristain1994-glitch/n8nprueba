import { NextRequest, NextResponse }  from 'next/server'
import { checkPermissionWithUser }    from '@/lib/permissions'
import { sendMessageUseCase }         from '@/lib/cloud-api/use-cases/send-message.use-case'
import { audit }                      from '@/lib/audit'
import type { SendMessageRequest }    from '@/lib/cloud-api/types/messages'
import {
  OptOutError,
  RateLimitError,
  ConversationWindowError,
  CloudApiError,
} from '@/lib/cloud-api/errors'

// POST /api/cloud/messages
// La ruta valida la sesión HTTP y delega toda la lógica al SendMessageUseCase.

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'send', 'create')
  if (!auth.ok) return auth.response

  let body: Partial<SendMessageRequest> & { enqueue?: boolean }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const { phoneNumberId, to, type, enqueue } = body

  if (!phoneNumberId || !to || !type) {
    return NextResponse.json({ error: 'Se requieren: phoneNumberId, to, type' }, { status: 400 })
  }

  if (!/^\+[1-9]\d{6,14}$/.test(to)) {
    return NextResponse.json(
      { error: 'Formato inválido. Usa E.164: +5491112345678' },
      { status: 400 },
    )
  }

  try {
    const result = await sendMessageUseCase.execute({
      request:  { ...body, sentByUserId: auth.user.user_id } as SendMessageRequest,
      enqueue:  enqueue ?? false,
    })

    void audit({
      req, action: 'create', resource: 'send',
      metadata: { phoneNumberId, to, type, wamid: result.wamid, messageId: result.messageId },
    })

    return NextResponse.json(result)

  } catch (err) {
    if (err instanceof OptOutError) {
      return NextResponse.json({ error: err.message, code: 'OPT_OUT' }, { status: 422 })
    }
    if (err instanceof ConversationWindowError) {
      return NextResponse.json({
        error: err.message,
        code:  'WINDOW_CLOSED',
        hint:  'Usa type "template" para iniciar la conversación.',
      }, { status: 422 })
    }
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { error: err.message, retryAfterMs: err.retryAfterMs },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(err.retryAfterMs / 1000)) } },
      )
    }
    if (err instanceof CloudApiError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 502 })
    }

    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
