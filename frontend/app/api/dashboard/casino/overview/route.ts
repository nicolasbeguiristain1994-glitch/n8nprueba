import { dashboardAgent } from '@/lib/dashboard-scope'
import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { isValidPlatform } from '@/lib/casino-agents'
import { argentinaToday, shiftDate, validDateRange } from '@/lib/dashboard-format'
import { overviewSql, type PlatformActivity } from '@/lib/dashboard-overview'

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
    const activity = await query<PlatformActivity>(overviewSql(platform), [from, to, dashboardAgent(platform, params.get('agent') || '') || null])
    return NextResponse.json({ activity }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'No se pudo consultar el resumen de plataformas' }, { status: 500 })
  }
}
