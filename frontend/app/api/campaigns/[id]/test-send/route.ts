import { NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import { audit } from '@/lib/audit'
import { CampaignTestError, SendCampaignTestSchema, getCampaignTestSnapshot, sendCampaignTest } from '@/lib/campaign-test-sends'

type Context = { params: Promise<{ id: string }> }
function failure(error: unknown) {
  return NextResponse.json({ error: error instanceof CampaignTestError ? error.message : 'No se pudo procesar la prueba.' },
    { status: error instanceof CampaignTestError ? error.status : 500 })
}
export async function GET(req: Request, context: Context) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'manage')
  if (!auth.ok) return auth.response
  if (auth.user.role !== 'admin') return NextResponse.json({ error: 'Las pruebas están disponibles solo para administradores.' }, { status: 403 })
  const { id } = await context.params
  if (!isUUID(id)) return NextResponse.json({ error: 'Campaña inválida.' }, { status: 400 })
  try { return NextResponse.json(await getCampaignTestSnapshot(id)) } catch (error) { return failure(error) }
}
export async function POST(req: Request, context: Context) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'manage')
  if (!auth.ok) return auth.response
  if (auth.user.role !== 'admin') return NextResponse.json({ error: 'Las pruebas están disponibles solo para administradores.' }, { status: 403 })
  const sendAuth = await checkPermissionWithUser(req, 'send', 'send')
  if (!sendAuth.ok) return sendAuth.response
  const { id } = await context.params
  if (!isUUID(id)) return NextResponse.json({ error: 'Campaña inválida.' }, { status: 400 })
  const parsed = SendCampaignTestSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Seleccioná el número de prueba y la línea de envío.' }, { status: 400 })
  try {
    const attempt = await sendCampaignTest(id, parsed.data, auth.user.user_id)
    void audit({ req, action: 'create', resource: 'campaigns', resource_id: id,
      metadata: { action: 'test_send', attempt_id: attempt.id, recipient_id: attempt.recipient_id, status: attempt.status } })
    return NextResponse.json({ attempt })
  } catch (error) { return failure(error) }
}
