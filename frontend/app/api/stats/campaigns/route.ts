import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { isUUID } from '@/lib/validate'
import { campaignStatistics, statisticsRange, STATS_TIMEZONE } from '@/lib/statistics'
import { CAMPAIGN_STATS_SQL, CAMPAIGN_OUTCOME_SQL } from '@/lib/campaign-stats'
import { CAMPAIGN_REPLIES_SQL } from '@/lib/campaign-replies'
import { campaignEffectiveness } from '@/lib/campaign-effectiveness'

export async function GET(req: NextRequest) {
  const auth=await checkPermissionWithUser(req,'estadisticas','read')
  if (!auth.ok) return auth.response
  const range=statisticsRange(req.nextUrl.searchParams)
  const id=req.nextUrl.searchParams.get('id') || ''
  if (!range || (id && !isUUID(id))) return NextResponse.json({error:'Período o ID inválido'},{status:400})
  const owner=auth.user.role==='admin'?null:auth.user.user_id
  try {
    if (id) {
      const rows=await query<Record<string, unknown>>(`SELECT c.created_at,
        s.sent AS enviados,s.delivered AS entregados,s.read AS leidos,s.failed AS fallidos,s.skipped AS omitidos,
        (SELECT count(*)::int FROM (${CAMPAIGN_REPLIES_SQL}) replies) AS respuestas,
        round(100.0*s.delivered/NULLIF(s.sent,0),1) AS tasa_entrega,
        round(100.0*s.read/NULLIF(s.sent,0),1) AS tasa_lectura
        FROM campaigns c CROSS JOIN LATERAL (${CAMPAIGN_STATS_SQL}) s
        WHERE c.id=$1 AND ($2::uuid IS NULL OR c.owned_by=$2)`,[id,owner])
      if (!rows.length) return NextResponse.json({error:'Campaña no encontrada'},{status:404})
      // Daily series uses the same recipient outcome rule as the campaign totals.
      const series=await query(`WITH outbound_days AS (
        SELECT (COALESCE(m.created_at,c.created_at) AT TIME ZONE '${STATS_TIMEZONE}')::date::text AS dia,
        COUNT(*) FILTER (WHERE ${CAMPAIGN_OUTCOME_SQL} IN ('sent','delivered','read'))::int AS enviados,
        COUNT(*) FILTER (WHERE ${CAMPAIGN_OUTCOME_SQL} IN ('delivered','read'))::int AS entregados,
        COUNT(*) FILTER (WHERE ${CAMPAIGN_OUTCOME_SQL}='read')::int AS leidos
        FROM campaigns c JOIN campaign_recipients cr ON cr.campaign_id=c.id
        LEFT JOIN LATERAL (SELECT wm.status,wm.created_at FROM whatsapp_messages wm
          WHERE wm.campaign_id=c.id AND wm.direction='outbound'
            AND regexp_replace(wm.phone_number,'[^0-9]','','g')=regexp_replace(cr.phone_number,'[^0-9]','','g')
          ORDER BY wm.created_at DESC,wm.id DESC LIMIT 1) m ON true
        WHERE c.id=$1 GROUP BY dia
      ), reply_days AS (
        SELECT (replies.created_at AT TIME ZONE '${STATS_TIMEZONE}')::date::text AS dia,
          COUNT(*)::int AS respuestas
        FROM campaigns c CROSS JOIN LATERAL (${CAMPAIGN_REPLIES_SQL}) replies
        WHERE c.id=$1 GROUP BY dia
      ) SELECT COALESCE(outbound_days.dia,reply_days.dia) AS dia,
        COALESCE(enviados,0) AS enviados,COALESCE(entregados,0) AS entregados,
        COALESCE(leidos,0) AS leidos,COALESCE(respuestas,0) AS respuestas
        FROM outbound_days FULL JOIN reply_days USING (dia) ORDER BY dia`,[id])
      const effectiveness=(await campaignEffectiveness([id],true)).get(id)!
      const {efectivos_detalle,...effectivenessKpis}=effectiveness
      return NextResponse.json({kpis:{...rows[0],...effectivenessKpis},efectivos:efectivos_detalle,series,timezone:STATS_TIMEZONE,metricScope:'campaign_recipients'})
    }
    const campaigns=await campaignStatistics(range.from,range.to,owner,req.nextUrl.searchParams.get('status')||'',req.nextUrl.searchParams.get('q')||'',true)
    return NextResponse.json({campaigns,timezone:STATS_TIMEZONE,metricScope:'campaign_recipients'})
  } catch {
    return NextResponse.json({error:'No se pudieron cargar las estadísticas de campañas'},{status:500})
  }
}
