import { cloudNumberRepository } from '@/lib/cloud-api/repositories/cloud-number.repository'
import { cloudNumberAccess } from '@/lib/cloud-api/access'
import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { connectDirectNumber, DirectConnectionSchema } from '@/lib/cloud-api/connection'
import { CloudApiError } from '@/lib/cloud-api/errors'
import { audit } from '@/lib/audit'

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lines', 'manage')
  if (!auth.ok) return auth.response
  const body = DirectConnectionSchema.safeParse(await req.json().catch(() => null))
  if (!body.success) return NextResponse.json({ error: 'Revisá los IDs, el token y el PIN de seis dígitos si solicitás registrar el número.' }, { status: 400 })
  if (await cloudNumberRepository.findByPhoneNumberId(body.data.phoneNumberId)) {
    const denied = await cloudNumberAccess(auth.user, body.data.phoneNumberId)
    if (denied) return denied
  }
  try {
    const result = await connectDirectNumber(body.data, auth.user.user_id)
    void audit({ req, action: 'manage', resource: 'lines', metadata: { action: 'cloud_direct_connect', phoneNumberId: result.phoneNumberId, lineId: result.lineId } })
    return NextResponse.json(result)
  } catch (err) {
    // Never log or echo the submitted token, PIN, Meta response or request URL.
    const message = err instanceof CloudApiError && !err.code ? err.message : 'No se pudo validar la conexión con Meta. Revisá permisos, WABA, número y configuración del servidor.'
    return NextResponse.json({ error: message }, { status: 422 })
  }
}
