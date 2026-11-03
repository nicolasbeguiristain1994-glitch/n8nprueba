import { authorizedDashboardAgent } from '@/lib/dashboard-access'
import { NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { readDashboardSnapshot } from '@/lib/dashboard-snapshot'
import { isValidPlatform } from '@/lib/casino-agents'
import { argentinaToday, shiftDate, validDateRange } from '@/lib/dashboard-format'

export async function GET(req: Request) {
  const auth = await checkPermissionWithUser(req, 'dashboard', 'read')
  if (!auth.ok) return auth.response
  const params = new URL(req.url).searchParams
  const platform = params.get('platform') || 'consolidado'
  const to = params.get('to') ?? argentinaToday()
  const from = params.get('from') ?? shiftDate(argentinaToday(), -6)
  if (!isValidPlatform(platform) || !validDateRange(from, to)) {
    return NextResponse.json({ error: 'Plataforma o período inválido' }, { status: 400 })
  }
  try {
    const scopeAccess = authorizedDashboardAgent(auth.user, platform, params.get('agent'))
    if (!scopeAccess.ok) return NextResponse.json({ error: 'Agente no permitido' }, { status: 403 })
    const agent = scopeAccess.agent
    const snapshot = await readDashboardSnapshot('deposits', { platform, from, to, agent }, params.get('refresh') === '1')
    return NextResponse.json({ ...snapshot.value, updatedAt: new Date(snapshot.updatedAt).toISOString() }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'No se pudieron consultar los depósitos. Reintentá la consulta.' }, { status: 500 })
  }
}
