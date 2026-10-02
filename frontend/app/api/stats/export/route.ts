import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { campaignStatistics, statisticsSeries, statisticsRange, csvCell, STATS_TIMEZONE } from '@/lib/statistics'
export async function GET(req: NextRequest) {
  const auth=await checkPermissionWithUser(req,'estadisticas','read')
  if (!auth.ok) return auth.response
  const range=statisticsRange(req.nextUrl.searchParams),type=req.nextUrl.searchParams.get('type')||'overview'
  if (!range || !['campaigns','overview'].includes(type)) return NextResponse.json({error:'Período o tipo inválido'},{status:400})
  const owner=auth.user.role==='admin'?null:auth.user.user_id
  try {
    const rows:Record<string,unknown>[]= type==='campaigns'
      ? (await campaignStatistics(range.from,range.to,owner,req.nextUrl.searchParams.get('status')||'',req.nextUrl.searchParams.get('q')||'')).map(c=>({
        'Campaña':c.name,'Tipo':c.type,'Estado':c.status,'Enviados':c.enviados,'Entregados':c.entregados,'Leídos':c.leidos,'Respuestas':c.respuestas,'Fallidos':c.fallidos,
        'Omitidos':c.omitidos,'Tasa entrega %':c.tasa_entrega,'Tasa lectura %':c.tasa_lectura,
        'Fecha creación':new Date(c.created_at as string).toLocaleDateString('es-AR',{timeZone:STATS_TIMEZONE})}))
      : (await statisticsSeries(range.from,range.to,owner)).map(c=>({'Fecha':c.dia,'Enviados':c.enviados,'Entregados':c.entregados,'Leídos':c.leidos,'Fallidos':c.fallidos,'Respuestas':c.respuestas}))
    if (!rows.length) return NextResponse.json({error:'Sin datos para exportar'},{status:404})
    const headers=Object.keys(rows[0]),csv=[headers.map(csvCell).join(','),...rows.map(r=>headers.map(h=>csvCell(r[h])).join(','))].join('\r\n')
    return new NextResponse('\uFEFF'+csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${type}_${range.from}_${range.to}.csv"`}})
  } catch { return NextResponse.json({error:'No se pudo exportar'},{status:500}) }
}
