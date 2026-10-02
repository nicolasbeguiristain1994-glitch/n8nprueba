import { NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { query } from '@/lib/db'
import { isValidPlatform } from '@/lib/casino-agents'
import { argentinaToday, shiftDate, validDateRange } from '@/lib/dashboard-format'
import { dashboardAgent } from '@/lib/dashboard-scope'
import { depositAnalytics, depositAnalyticsSql, type DepositAggregateRow } from '@/lib/dashboard-deposits'

export async function GET(req: Request) {
  const denied = await checkPermission(req, 'dashboard', 'read')
  if (denied) return denied
  const params = new URL(req.url).searchParams
  const platform = params.get('platform') || 'consolidado'
  const to = params.get('to') ?? argentinaToday()
  const from = params.get('from') ?? shiftDate(argentinaToday(), -6)
  if (!isValidPlatform(platform) || !validDateRange(from, to)) {
    return NextResponse.json({ error: 'Plataforma o período inválido' }, { status: 400 })
  }
  try {
    const agent = dashboardAgent(platform, params.get('agent') || '') || null
    const rows = await query<DepositAggregateRow>(depositAnalyticsSql(platform), [from, to, agent])
    return NextResponse.json(depositAnalytics(rows, platform), { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'No se pudieron consultar los depósitos. Reintentá la consulta.' }, { status: 500 })
  }
}
