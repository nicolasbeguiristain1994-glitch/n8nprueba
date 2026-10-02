import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { getAccessibleLineIds } from '@/lib/line-visibility'
import { buildCloudReadinessResponse, fetchCloudReadinessRows } from '@/lib/cloud-api/campaign-readiness'
import { appLog } from '@/lib/security-log'

// GET /api/campaigns/cloud-readiness — diagnóstico local (sólo lectura) de líneas Cloud API.
// No consulta Meta, no lee valores de token y no habilita envíos.

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'read')
  if (!auth.ok) return auth.response

  try {
    const ids = await getAccessibleLineIds(auth.user)
    const rows = await fetchCloudReadinessRows(ids)
    return NextResponse.json(buildCloudReadinessResponse(rows, new Date()), { headers: NO_STORE })
  } catch (err) {
    appLog('ERROR', '[campaigns/cloud-readiness GET]', { error: err instanceof Error ? err.name : 'unknown' })
    return NextResponse.json(
      { error: 'No se pudo obtener el diagnóstico local de WhatsApp Cloud API' },
      { status: 500, headers: NO_STORE },
    )
  }
}
