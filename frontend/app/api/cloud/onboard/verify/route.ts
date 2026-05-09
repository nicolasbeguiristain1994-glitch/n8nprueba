import { NextRequest, NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { verifyOTPAndActivate } from '@/lib/cloud-api/embedded-signup'
import { getTokenForNumber } from '@/lib/cloud-api/token-store'
import { audit } from '@/lib/audit'

// POST /api/cloud/onboard/verify
// Permite verificar el OTP manualmente si el cliente nos lo proporciona.
// En el flujo estándar de Coexistence, el OTP se ingresa directamente en
// la WhatsApp Business App y Meta lo verifica automáticamente.
// Este endpoint es para casos donde se necesita verificación manual.

export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err

  let body: { phoneNumberId?: string; otpCode?: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const { phoneNumberId, otpCode } = body

  if (!phoneNumberId || !otpCode) {
    return NextResponse.json({ error: 'Se requieren: phoneNumberId, otpCode' }, { status: 400 })
  }

  try {
    const accessToken = await getTokenForNumber(phoneNumberId)
    const result = await verifyOTPAndActivate(phoneNumberId, otpCode, accessToken)

    void audit({
      req,
      action:   'manage',
      resource: 'lines',
      metadata: { action: 'cloud_verify_otp', phoneNumberId },
    })

    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
