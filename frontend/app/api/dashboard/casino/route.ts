import { NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { isValidPlatform } from '@/lib/casino-agents'
import { argentinaToday, shiftDate, validDateRange } from '@/lib/dashboard-format'
import { dashboardAgent } from '@/lib/dashboard-scope'
import { readDashboardSnapshot } from '@/lib/dashboard-snapshot'
export type { CasinoSummary, CasinoAgente, CasinoVip, SegCount, CasinoDashboardData } from '@/lib/dashboard-casino'

export async function GET(req: Request) {
  const err = await checkPermission(req, 'dashboard', 'read')
  if (err) return err
  const params = new URL(req.url).searchParams
  const platform = params.get('platform')?.trim() || 'zeus'
  const from = params.get('from') ?? shiftDate(argentinaToday(), -29)
  const to = params.get('to') ?? argentinaToday()
  if (!isValidPlatform(platform) || !validDateRange(from, to)) {
    return NextResponse.json({ error: 'Plataforma o período inválido' }, { status: 400 })
  }
  const agent = dashboardAgent(platform, params.get('agent') || '') || null
  try {
    const snapshot = await readDashboardSnapshot('casino', { platform, from, to, agent }, params.get('refresh') === '1')
    return NextResponse.json({ ...snapshot.value, updatedAt: new Date(snapshot.updatedAt).toISOString() }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[/api/dashboard/casino GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'No se pudieron consultar las cuentas de casino' }, { status: 500 })
  }
}
