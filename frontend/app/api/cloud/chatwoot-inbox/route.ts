import { cloudNumberAccess } from '@/lib/cloud-api/access'
import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser }   from '@/lib/permissions'
import { createChatwootInboxUseCase, ChatwootNotConfiguredError } from '@/lib/cloud-api/use-cases/create-chatwoot-inbox.use-case'
import { CloudApiError }             from '@/lib/cloud-api/errors'
import { audit }                     from '@/lib/audit'
import { z }                         from 'zod'

const BodySchema = z.object({ phoneNumberId: z.string().min(1) })

// POST /api/cloud/chatwoot-inbox
// Crea un inbox de WhatsApp Cloud en Chatwoot para el número indicado.
export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lines', 'manage')
  if (!auth.ok) return auth.response

  const raw = await req.json().catch(() => null)
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'phoneNumberId es requerido' }, { status: 400 })
  }

  const { phoneNumberId } = parsed.data

  const denied = await cloudNumberAccess(auth.user, phoneNumberId)
  if (denied) return denied
  try {
    const result = await createChatwootInboxUseCase.execute(phoneNumberId)
    void audit({ req, action: 'create', resource: 'chatwoot_inbox', resource_id: result.inboxId,
      metadata: { phoneNumberId, inboxName: result.inboxName } })
    return NextResponse.json({ ok: true, inboxId: result.inboxId, inboxName: result.inboxName })
  } catch (e) {
    if (e instanceof ChatwootNotConfiguredError) {
      return NextResponse.json({
        error: 'La integración con Chatwoot no está disponible. La bandeja nativa sigue disponible para esta línea.',
        code:  'CHATWOOT_NOT_CONFIGURED',
      }, { status: 409 })
    }
    const msg = 'No se pudo crear la bandeja de Chatwoot. Revisá su configuración.'
    const status = e instanceof CloudApiError ? 422 : 500
    console.error('[/api/cloud/chatwoot-inbox POST] failed')
    return NextResponse.json({ error: msg }, { status })
  }
}
