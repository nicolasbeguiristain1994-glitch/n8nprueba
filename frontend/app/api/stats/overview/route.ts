import { agentScope, campaignScopeSql } from '@/lib/agent-scope'
import { activityCte, statisticsArgs } from '@/lib/statistics'
import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { ACTIVITY_METRICS, campaignStatistics, statisticsRange, statisticsSeries, STATS_FROM, STATS_TO, STATS_TIMEZONE } from '@/lib/statistics'
export async function GET(req: NextRequest) {
  const auth=await checkPermissionWithUser(req,'estadisticas','read')
  if (!auth.ok) return auth.response
  const range=statisticsRange(req.nextUrl.searchParams)
  if (!range) return NextResponse.json({error:'Período inválido'},{status:400})
  const owner=auth.user.role==='admin'?null:auth.user.user_id
  const agents = agentScope(auth.user)
  const args=statisticsArgs(range.from,range.to,owner,agents)
  try {
    const [kpis,series,distribution,campaigns,counts]=await Promise.all([
      query<Record<string,number>>(`${activityCte(agents)} SELECT ${ACTIVITY_METRICS} FROM activity`,args),
      statisticsSeries(range.from,range.to,owner,agents),
      query(`${activityCte(agents)} SELECT status,count(*)::int AS n FROM activity WHERE direction='outbound' GROUP BY status ORDER BY n DESC`,args),
      campaignStatistics(range.from,range.to,owner,'','',false,'sent',agents),
      query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE status='completed')::int AS completadas,
        count(*) FILTER(WHERE status::text IN ('running','sending'))::int AS activas,
        count(*) FILTER(WHERE status::text IN ('draft','scheduled'))::int AS programadas FROM campaigns c
        WHERE created_at >= ${STATS_FROM} AND created_at < ${STATS_TO} AND ${agents === null ? '($3::uuid IS NULL OR owned_by=$3)' : campaignScopeSql('c','$3','$4')}`,args),
    ])
    const k=kpis[0]??{}
    const pct=(value:number)=>k.enviados?Math.round(1000*value/k.enviados)/10:null
    const attempted=k.enviados+k.fallidos
    return NextResponse.json({kpis:{...k,tasa_entrega:attempted?Math.round(1000*k.entregados/attempted)/10:null,tasa_lectura:pct(k.leidos),tasa_respuesta:pct(k.respuestas)},series,distribution,
      topCampaigns:campaigns.slice(0,6).map(c=>({...c,total:c.enviados})),campaignCount:counts[0]??{},timezone:STATS_TIMEZONE})
  } catch { return NextResponse.json({error:'No se pudieron cargar las estadísticas'},{status:500}) }
}
