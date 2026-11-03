import { authorizedDashboardAgent } from '@/lib/dashboard-access'
import { NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isValidPlatform } from '@/lib/casino-agents'
import { argentinaToday, shiftDate, validDateRange } from '@/lib/dashboard-format'
import { readDashboardSnapshot } from '@/lib/dashboard-snapshot'

export async function GET(req: Request) {
  const auth = await checkPermissionWithUser(req, 'dashboard', 'read')
  if (!auth.ok) return auth.response
  const params = new URL(req.url).searchParams
  const platform = params.get('platform')?.trim() || 'zeus'
  const from = params.get('from') ?? shiftDate(argentinaToday(), -29)
  const to = params.get('to') ?? argentinaToday()
  if (!isValidPlatform(platform) || !validDateRange(from, to)) {
    return NextResponse.json({ error: 'Plataforma o período inválido' }, { status: 400 })
  }
  const scopeAccess = authorizedDashboardAgent(auth.user, platform, params.get('agent'))
  if (!scopeAccess.ok) return NextResponse.json({ error: 'Agente no permitido' }, { status: 403 })
  const agent = scopeAccess.agent
  try {
    const snapshot = await readDashboardSnapshot('agents', { platform, from, to, agent }, params.get('refresh') === '1')
    return NextResponse.json({ ...snapshot.value, updatedAt: new Date(snapshot.updatedAt).toISOString() }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[/api/dashboard/casino/agents GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'No se pudieron consultar las ventas y los usuarios por agente' }, { status: 500 })
  }
}
