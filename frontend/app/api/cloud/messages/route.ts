import { randomUUID } from 'node:crypto'
import { query } from '@/lib/db'
import { reserveLineSendBudget,finishLineSendBudget,LineSendBudgetError } from '@/lib/line-send-budget'
import { recordHumanAutomationIntervention } from '@/lib/automation-safety'
import { CampaignRiskError } from '@/lib/campaign-risk'
import { buildMessagePayload } from '@/lib/cloud-api/infrastructure/message-sender.service'
import { cloudNumberAccess } from '@/lib/cloud-api/access'
import { NextRequest, NextResponse }  from 'next/server'
import { checkPermissionWithUser }    from '@/lib/permissions'
import { sendMessageUseCase }         from '@/lib/cloud-api/use-cases/send-message.use-case'
import { audit }                      from '@/lib/audit'
import { appLog }                     from '@/lib/security-log'
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
  const auth = await checkPermissionWithUser(req, 'send', 'send')
  if (!auth.ok) return auth.response

  let body: Partial<SendMessageRequest> & { enqueue?: boolean }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  if(body.agentCode !== undefined || body.campaignId !== undefined) {
    return NextResponse.json({error:'El agente y la campaña se resuelven internamente. Usá el envío de Campañas para una difusión.'},{status:400})
  }
  const { phoneNumberId, to, type, enqueue } = body

  if (typeof phoneNumberId !== 'string' || !/^\d{5,30}$/.test(phoneNumberId) || typeof to !== 'string' || typeof type !== 'string') {
    return NextResponse.json({ error: 'Se requieren: phoneNumberId, to, type' }, { status: 400 })
  }

  if (!/^\+[1-9]\d{6,14}$/.test(to)) {
    return NextResponse.json(
      { error: 'Formato inválido. Usa E.164: +5491112345678' },
      { status: 400 },
    )
  }

  try { buildMessagePayload(body as SendMessageRequest) } catch { return NextResponse.json({ error: 'Contenido del mensaje inválido' }, { status: 400 }) }
  const denied = await cloudNumberAccess(auth.user, phoneNumberId)
  if (denied) return denied
  if (enqueue && process.env.CLOUD_MESSAGE_WORKER_ENABLED !== 'true') return NextResponse.json({ error: 'La cola requiere un worker habilitado. Usá envío directo.' }, { status: 503 })

  let reservationId:string|null=null
  let accepted=false
  try {
    const [line]=await query<{id:string}>('SELECT whatsapp_line_id AS id FROM cloud_numbers WHERE phone_number_id=$1',[phoneNumberId])
    if(!line?.id) return NextResponse.json({error:'La línea de origen no está disponible.'},{status:409})
    const agentCode=await recordHumanAutomationIntervention(to,{provider:'cloud',sourceId:phoneNumberId})
    reservationId=(await reserveLineSendBudget({lineId:line.id,purpose:'service',sendKey:`service:${auth.user.user_id}:${randomUUID()}`})).id
    const result = await sendMessageUseCase.execute({
      request:  { ...body,...(agentCode?{agentCode}:{}), sentByUserId: auth.user.user_id } as SendMessageRequest,
      enqueue:  enqueue ?? false,
    })

    accepted=true
    await finishLineSendBudget(reservationId,'consumed')
    void audit({
      req, action: 'create', resource: 'send',
      metadata: { phoneNumberId, to, type, wamid: result.wamid, messageId: result.messageId },
    })

    return NextResponse.json(result)

  } catch (err) {
    if(reservationId) {
      const noSend=!accepted && (err instanceof CampaignRiskError || err instanceof OptOutError || err instanceof ConversationWindowError || err instanceof RateLimitError || (err instanceof Error && err.name==='TokenExpiredError'))
      await finishLineSendBudget(reservationId,noSend?'no_send':'consumed').catch(()=>{})
    }
    if(err instanceof LineSendBudgetError) return NextResponse.json({error:err.message,code:err.code,retryAt:err.retryAt},{status:409})
    if (err instanceof CampaignRiskError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 })
    }
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

    appLog('ERROR', '[cloud/messages POST]', { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
