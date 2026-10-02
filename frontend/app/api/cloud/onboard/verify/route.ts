import { cloudNumberAccess } from '@/lib/cloud-api/access'
import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { verifyOTPAndActivate } from '@/lib/cloud-api/embedded-signup'
import { getTokenForNumber } from '@/lib/cloud-api/token-store'
import { audit } from '@/lib/audit'

// POST /api/cloud/onboard/verify
// Permite verificar el OTP manualmente si el cliente nos lo proporciona.
// En el flujo estándar de Coexistence, el OTP se ingresa directamente en
// la WhatsApp Business App y Meta lo verifica automáticamente.
// Este endpoint es para casos donde se necesita verificación manual.

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lines', 'manage')
  if (!auth.ok) return auth.response

  let body: { phoneNumberId?: string; otpCode?: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const { phoneNumberId, otpCode } = body

  if (typeof phoneNumberId !== 'string' || !/^\d{5,30}$/.test(phoneNumberId) || typeof otpCode !== 'string' || !/^\d{6}$/.test(otpCode)) {
    return NextResponse.json({ error: 'Se requieren: phoneNumberId, otpCode' }, { status: 400 })
  }

  const denied = await cloudNumberAccess(auth.user, phoneNumberId)
  if (denied) return denied
  try {
    const accessToken = await getTokenForNumber(phoneNumberId, true)
    const result = await verifyOTPAndActivate(phoneNumberId, otpCode, accessToken)

    void audit({
      req,
      action:   'manage',
      resource: 'lines',
      metadata: { action: 'cloud_verify_otp', phoneNumberId },
    })

    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: 'No se pudo verificar el número. Revisá el código y su estado en Meta.' }, { status: 422 })
  }
}
