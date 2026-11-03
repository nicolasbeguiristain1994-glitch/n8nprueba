import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { checkPermissionWithUser } from '@/lib/permissions'
import { BroadcastPlanError, getBroadcastPlanningOptions, prepareDailyBroadcast } from '@/lib/broadcast-plan-repository'

const schema = z.object({
  platform:z.enum(['zeus','bet30','ganamos','argenbet']).optional(),agent:z.string().trim().min(1).max(50).optional(),
  valueTier:z.enum(['super_vip','vip_alto','vip_medio','vip','medio','bajo']).optional(),
  reactivationSegment:z.enum(['REACTIVACION_URGENTE','REACTIVACION_PRIORITARIA','REACTIVACION_ESTANDAR','REACTIVACION_FRIA_ALTO_VALOR','REACTIVACION_FRIA']).optional(),
  lineIds:z.array(z.string().uuid()).min(1).max(100).transform(ids => [...new Set(ids)]),
  messageType:z.enum(['template','text']),templateId:z.string().uuid().optional(),
  endTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  reservePercent:z.number().int().min(0).max(50),maxContacts:z.number().int().min(1).max(5000),
}).strict().refine(v => v.messageType !== 'template' || !!v.templateId,{message:'Seleccioná una plantilla aprobada.'})

async function authorize(req: NextRequest) {
  const auth = await checkPermissionWithUser(req,'priorities','read')
  if (!auth.ok) return auth
  const campaigns = await checkPermissionWithUser(req,'campaigns','create')
  if (!campaigns.ok) return campaigns
  const lines = await checkPermissionWithUser(req,'lines','read')
  if (!lines.ok) return lines
  return auth
}

function errorResponse(error: unknown) {
  if (error instanceof BroadcastPlanError) return NextResponse.json({error:error.message},{status:error.status})
  console.error('[broadcast-plan]',error instanceof Error ? error.message : 'Unknown error')
  return NextResponse.json({error:'No se pudo preparar la difusión. Intentá nuevamente.'},{status:500})
}

export async function GET(req: NextRequest) {
  const auth = await authorize(req)
  if (!auth.ok) return auth.response
  try { return NextResponse.json(await getBroadcastPlanningOptions(auth.user),{headers:{'Cache-Control':'no-store'}}) }
  catch (error) { return errorResponse(error) }
}

export async function POST(req: NextRequest) {
  const auth = await authorize(req)
  if (!auth.ok) return auth.response
  const parsed = schema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({error:parsed.error.issues[0]?.message ?? 'Datos inválidos'},{status:400})
  try { return NextResponse.json(await prepareDailyBroadcast(auth.user,parsed.data),{headers:{'Cache-Control':'no-store'}}) }
  catch (error) { return errorResponse(error) }
}
