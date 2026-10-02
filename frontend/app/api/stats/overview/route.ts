import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { ACTIVITY_CTE, ACTIVITY_METRICS, campaignStatistics, statisticsRange, statisticsSeries, STATS_FROM, STATS_TO, STATS_TIMEZONE } from '@/lib/statistics'
export async function GET(req: NextRequest) {
  const auth=await checkPermissionWithUser(req,'estadisticas','read')
  if (!auth.ok) return auth.response
  const range=statisticsRange(req.nextUrl.searchParams)
  if (!range) return NextResponse.json({error:'Período inválido'},{status:400})
  const owner=auth.user.role==='admin'?null:auth.user.user_id
  const args=[range.from,range.to,owner]
  try {
    const [kpis,series,distribution,campaigns,counts]=await Promise.all([
      query<Record<string,number>>(`${ACTIVITY_CTE} SELECT ${ACTIVITY_METRICS} FROM activity`,args),
      statisticsSeries(range.from,range.to,owner),
      query(`${ACTIVITY_CTE} SELECT status,count(*)::int AS n FROM activity WHERE direction='outbound' GROUP BY status ORDER BY n DESC`,args),
      campaignStatistics(range.from,range.to,owner),
      query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE status='completed')::int AS completadas,
        count(*) FILTER(WHERE status::text IN ('running','sending'))::int AS activas,
        count(*) FILTER(WHERE status::text IN ('draft','scheduled'))::int AS programadas FROM campaigns
        WHERE created_at >= ${STATS_FROM} AND created_at < ${STATS_TO} AND ($3::uuid IS NULL OR owned_by=$3)`,args),
    ])
    const k=kpis[0]??{}
    const pct=(value:number)=>k.enviados?Math.round(1000*value/k.enviados)/10:null
    return NextResponse.json({kpis:{...k,tasa_entrega:pct(k.entregados),tasa_lectura:pct(k.leidos),tasa_respuesta:pct(k.respuestas)},series,distribution,
      topCampaigns:campaigns.slice(0,6).map(c=>({...c,total:c.enviados})),campaignCount:counts[0]??{},timezone:STATS_TIMEZONE})
  } catch { return NextResponse.json({error:'No se pudieron cargar las estadísticas'},{status:500}) }
}
