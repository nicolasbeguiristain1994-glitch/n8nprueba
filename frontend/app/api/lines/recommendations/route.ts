import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { getAccessibleLineIds } from '@/lib/line-visibility'
import { getLineVolumeInputs } from '@/lib/line-volume-data'
import { LINE_VOLUME_TIME_ZONE, recommendLineVolume } from '@/lib/line-volume-policy'

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lines', 'read')
  if (!auth.ok) return auth.response
  const headers = { 'Cache-Control': 'private, no-store' }
  try {
    const ids = await getAccessibleLineIds(auth.user)
    const now = new Date()
    const inputs = await getLineVolumeInputs(ids, now)
    return NextResponse.json({ recommendations: Object.fromEntries(inputs.map(input => [input.id,recommendLineVolume(input)])),
      asOf: now.toISOString(),timeZone: LINE_VOLUME_TIME_ZONE }, { headers })
  } catch {
    // Do not expose provider data, SQL or connection details through this read endpoint.
    console.error('[/api/lines/recommendations] No se pudo calcular la recomendación')
    return NextResponse.json({ error: 'No se pudieron calcular las recomendaciones. Intentá actualizar en unos minutos.' }, { status: 503,headers })
  }
}
