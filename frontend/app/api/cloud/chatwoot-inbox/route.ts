import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser }   from '@/lib/permissions'
import { createChatwootInboxUseCase } from '@/lib/cloud-api/use-cases/create-chatwoot-inbox.use-case'
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

  try {
    const result = await createChatwootInboxUseCase.execute(phoneNumberId)
    void audit({ req, action: 'create', resource: 'chatwoot_inbox', resource_id: result.inboxId,
      metadata: { phoneNumberId, inboxName: result.inboxName } })
    return NextResponse.json({ ok: true, inboxId: result.inboxId, inboxName: result.inboxName })
  } catch (e) {
    const msg = e instanceof CloudApiError ? e.message : 'Error interno del servidor'
    const status = e instanceof CloudApiError ? 422 : 500
    console.error('[/api/cloud/chatwoot-inbox POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: msg }, { status })
  }
}
