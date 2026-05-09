import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { startCoexistenceOnboarding } from '@/lib/cloud-api/embedded-signup'
import { audit } from '@/lib/audit'
import type { OnboardingRequest } from '@/lib/cloud-api/types'

// POST /api/cloud/onboard
// Recibe el resultado del Embedded Signup (code, waba_id, phone_number_id)
// y dispara el flujo completo de onboarding con Coexistence.
//
// Body: { code: string, wabaId: string, phoneNumberId: string, whatsappLineId?: string }

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lines', 'manage')
  if (!auth.ok) return auth.response

  let body: Partial<OnboardingRequest>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const { code, wabaId, phoneNumberId, whatsappLineId } = body

  if (!code || !wabaId || !phoneNumberId) {
    return NextResponse.json(
      { error: 'Se requieren: code, wabaId, phoneNumberId' },
      { status: 400 },
    )
  }

  try {
    const result = await startCoexistenceOnboarding(
      { code, wabaId, phoneNumberId, whatsappLineId },
      auth.user.user_id,
    )

    void audit({
      req,
      action:   'manage',
      resource: 'lines',
      metadata: {
        action:        'cloud_onboard',
        phoneNumberId,
        wabaId,
        status:        result.status,
        cloudNumberId: result.cloudNumberId,
      },
    })

    return NextResponse.json(result, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[cloud/onboard] Error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
