import { NextRequest, NextResponse }      from 'next/server'
import { checkPermissionWithUser }        from '@/lib/permissions'
import { onboardCoexistenceUseCase }      from '@/lib/cloud-api/use-cases/onboard-coexistence.use-case'
import { audit }                          from '@/lib/audit'
import { appLog }                         from '@/lib/security-log'
import type { OnboardingRequest }         from '@/lib/cloud-api/types/domain'

// POST /api/cloud/onboard
// Recibe el resultado del Embedded Signup y delega al OnboardCoexistenceUseCase.

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lines', 'manage')
  if (!auth.ok) return auth.response

  let body: Partial<OnboardingRequest>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const { code, wabaId, phoneNumberId, whatsappLineId } = body

  if (!code || !wabaId || !phoneNumberId) {
    return NextResponse.json({ error: 'Se requieren: code, wabaId, phoneNumberId' }, { status: 400 })
  }

  try {
    const result = await onboardCoexistenceUseCase.execute(
      { code, wabaId, phoneNumberId, whatsappLineId },
      auth.user.user_id,
    )

    void audit({
      req, action: 'manage', resource: 'lines',
      metadata: { action: 'cloud_onboard', ...result },
    })

    return NextResponse.json(result)
  } catch (err) {
    appLog('ERROR', '[cloud/onboard]', { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
