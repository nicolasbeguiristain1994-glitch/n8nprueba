import { NextRequest, NextResponse } from 'next/server'
import { BroadcastPlanOptionsSchema } from '@/lib/broadcast-plan-schema'
import { checkPermissionWithUser } from '@/lib/permissions'
import { BroadcastPlanError, getBroadcastPlanningOptions, prepareDailyBroadcast } from '@/lib/broadcast-plan-repository'


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
  return NextResponse.json({error:'No se pudo planificar la difusión. Intentá nuevamente.'},{status:500})
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
  const parsed = BroadcastPlanOptionsSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({error:parsed.error.issues[0]?.message ?? 'Datos inválidos'},{status:400})
  try { return NextResponse.json(await prepareDailyBroadcast(auth.user,parsed.data),{headers:{'Cache-Control':'no-store'}}) }
  catch (error) { return errorResponse(error) }
}
