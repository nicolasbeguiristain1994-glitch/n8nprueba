import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { query } from '@/lib/db'
import { audit } from '@/lib/audit'
import { PriorityBroadcastSchema, PriorityBroadcastError, preparePriorityBroadcast } from '@/lib/user-prioritization/broadcasts'

export async function POST(req:NextRequest) {
  const auth=await checkPermissionWithUser(req,'contacts','read')
  if(!auth.ok) return auth.response
  for(const [resource,action] of [['campaigns','create'],['send','send']] as const) {
    const permission=await checkPermissionWithUser(req,resource,action)
    if(!permission.ok) return permission.response
  }
  const parsed=PriorityBroadcastSchema.safeParse(await req.json().catch(()=>null))
  if(!parsed.success) return NextResponse.json({error:'Seleccioná entre 1 y 200 contactos y completá la plantilla'},{status:400})
  try {
    const result=await preparePriorityBroadcast(auth.user,parsed.data)
    if(!result.reused) void audit({req,action:'create',resource:'campaigns',resource_id:result.campaign_id,
      metadata:{source:'priorities',contacts:new Set(parsed.data.contact_ids).size}})
    return NextResponse.json(result,{status:result.reused?200:201})
  } catch(error) {
    if(error instanceof PriorityBroadcastError) return NextResponse.json({error:error.message},{status:error.status})
    console.error('[priorities broadcast]',error instanceof Error?error.message:error)
    return NextResponse.json({error:'No se pudo preparar la difusión. Reintentá con la misma selección.'},{status:500})
  }
}
export async function GET(req:NextRequest) {
  const auth=await checkPermissionWithUser(req,'contacts','read')
  if(!auth.ok) return auth.response
  const permission=await checkPermissionWithUser(req,'campaigns','read')
  if(!permission.ok) return permission.response
  try {
    const broadcasts=await query(`SELECT c.id,c.name,c.status,c.pause_reason,c.created_at,c.total_targets,
      wt.name template_name,
      COUNT(cr.id) FILTER(WHERE cr.status='sent')::int AS sent,
      COUNT(cr.id) FILTER(WHERE cr.status='failed')::int AS failed,
      COUNT(cr.id) FILTER(WHERE cr.status='skipped')::int AS skipped,
      COUNT(cr.id) FILTER(WHERE cr.status IN ('pending','sending'))::int AS pending
      FROM (SELECT c.* FROM campaigns c JOIN priority_broadcasts pb ON pb.campaign_id=c.id
        WHERE c.owned_by=$1 ORDER BY c.created_at DESC LIMIT 10) c
      LEFT JOIN campaign_recipients cr ON cr.campaign_id=c.id
      LEFT JOIN whatsapp_templates wt ON wt.id=c.template_id
      GROUP BY c.id,c.name,c.status,c.pause_reason,c.created_at,c.total_targets,wt.name
      ORDER BY c.created_at DESC`,[auth.user.user_id])
    return NextResponse.json({broadcasts})
  } catch {return NextResponse.json({error:'No se pudo consultar el progreso de las difusiones'},{status:500})}
}
