import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { LtvService } from '@/lib/ltv/LtvService'
import type { ValueTier } from '@/lib/user-prioritization/config'

const service = new LtvService()

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'read')
  if (!auth.ok) return auth.response

  const { searchParams } = req.nextUrl
  const agente       = searchParams.get('agente')      ?? undefined
  const tierLtv      = searchParams.get('tier')        ?? undefined
  const minPercentil = searchParams.get('min_percentil')
  const page         = Number(searchParams.get('page') ?? '1')
  const pageSize     = Number(searchParams.get('page_size') ?? '50')

  const percentile = minPercentil === null ? undefined : Number(minPercentil)
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200
    || (percentile !== undefined && (!Number.isFinite(percentile) || percentile < 0 || percentile > 100))
    || (tierLtv !== undefined && !['super_vip','vip_alto','vip_medio','vip','medio','bajo'].includes(tierLtv))) {
    return NextResponse.json({ error: 'Filtros o paginación inválidos' }, { status: 400 })
  }

  try {
    const result = await service.getPlayers({
      access: auth.user,
      agente,
      tierLtv:      tierLtv as ValueTier | undefined,
      minPercentil: percentile,
      page,
      pageSize,
    })
    return NextResponse.json(result)
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
