import { cloudNumberRepository } from '@/lib/cloud-api/repositories/cloud-number.repository'
import { cloudNumberAccess } from '@/lib/cloud-api/access'
import { z } from 'zod'
import { query } from '@/lib/db'
import { getAccessibleLineIds } from '@/lib/line-visibility'
import { CloudApiError } from '@/lib/cloud-api/errors'
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

  const parsed = z.object({code:z.string().min(1).max(4096),wabaId:z.string().regex(/^\d{5,30}$/),phoneNumberId:z.string().regex(/^\d{5,30}$/),whatsappLineId:z.string().uuid().optional(),coexistenceEnabled:z.boolean().optional()}).strict().safeParse(body)
  if (!parsed.success) return NextResponse.json({error:'Datos de conexión inválidos'}, {status:400})
  const { code, wabaId, phoneNumberId, whatsappLineId, coexistenceEnabled } = parsed.data
  if (whatsappLineId) {
    const ids=await getAccessibleLineIds(auth.user)
    const rows=await query<{line_type:string}>('SELECT line_type FROM whatsapp_lines WHERE id=$1',[whatsappLineId])
    if (!rows.length || (ids!==null&&!ids.includes(whatsappLineId)) || rows[0].line_type!=='cloud') return NextResponse.json({error:'Elegí una línea Cloud API propia'}, {status:403})
    const linked=await query('SELECT 1 FROM cloud_numbers WHERE whatsapp_line_id=$1 AND phone_number_id<>$2',[whatsappLineId,phoneNumberId])
    if(linked.length)return NextResponse.json({error:'La línea ya tiene otro número vinculado'}, {status:409})
  }

  if (!code || !wabaId || !phoneNumberId) {
    return NextResponse.json({ error: 'Se requieren: code, wabaId, phoneNumberId' }, { status: 400 })
  }

  if (await cloudNumberRepository.findByPhoneNumberId(phoneNumberId)) {
    const denied = await cloudNumberAccess(auth.user, phoneNumberId)
    if (denied) return denied
  }
  try {
    const result = await onboardCoexistenceUseCase.execute(
      { code, wabaId, phoneNumberId, whatsappLineId, coexistenceEnabled: coexistenceEnabled === true },
      auth.user.user_id,
    )

    void audit({
      req, action: 'manage', resource: 'lines',
      metadata: { action: 'cloud_onboard', ...result },
    })

    return NextResponse.json(result)
  } catch (err) {
    const error = err instanceof CloudApiError && !err.code ? err.message : 'No se pudo completar la conexión con Meta. Revisá permisos y configuración.'
    return NextResponse.json({ error }, { status: 422 })
  }
}
