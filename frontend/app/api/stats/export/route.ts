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
      ? (await campaignStatistics(range.from,range.to,owner,req.nextUrl.searchParams.get('status')||'',req.nextUrl.searchParams.get('q')||'',true)).map(c=>({
        'Campaña':c.name,'Tipo':c.type,'Estado':c.status,'Enviados':c.enviados,'Entregados':c.entregados,'Leídos':c.leidos,'Respuestas':c.respuestas,'Fallidos':c.fallidos,
        'Omitidos':c.omitidos,'Tasa entrega %':c.tasa_entrega,'Tasa lectura %':c.tasa_lectura,
        'Efectivos (24 h)':c.efectivos,'Efectividad %':c.tasa_efectividad,'Cargas (24 h)':c.cargas_24h,
        'Monto cargado (24 h)':c.monto_cargado_24h,'Monto apostado (24 h)':'No disponible',
        'Ventanas abiertas':c.ventanas_abiertas,'Sin cuenta vinculada':c.sin_cuenta,
        'Sin hora de envío':c.sin_hora_envio,'Cargas sin hora (no atribuidas)':c.cargas_sin_hora,
        'Fecha creación':new Date(c.created_at as string).toLocaleDateString('es-AR',{timeZone:STATS_TIMEZONE})}))
      : (await statisticsSeries(range.from,range.to,owner)).map(c=>({'Fecha':c.dia,'Enviados':c.enviados,'Entregados':c.entregados,'Leídos':c.leidos,'Fallidos':c.fallidos,'Respuestas':c.respuestas}))
    if (!rows.length) return NextResponse.json({error:'Sin datos para exportar'},{status:404})
    const headers=Object.keys(rows[0]),csv=[headers.map(csvCell).join(','),...rows.map(r=>headers.map(h=>csvCell(r[h])).join(','))].join('\r\n')
    return new NextResponse('\uFEFF'+csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${type}_${range.from}_${range.to}.csv"`}})
  } catch { return NextResponse.json({error:'No se pudo exportar'},{status:500}) }
}
