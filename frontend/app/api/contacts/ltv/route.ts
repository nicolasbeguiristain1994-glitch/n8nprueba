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
  const page         = parseInt(searchParams.get('page')      ?? '1',  10)
  const pageSize     = parseInt(searchParams.get('page_size') ?? '50', 10)

  if (pageSize < 1 || pageSize > 200) {
    return NextResponse.json({ error: 'page_size debe estar entre 1 y 200' }, { status: 400 })
  }

  try {
    const result = await service.getPlayers({
      agente,
      tierLtv:      tierLtv as ValueTier | undefined,
      minPercentil: minPercentil ? parseFloat(minPercentil) : undefined,
      page,
      pageSize,
    })
    return NextResponse.json(result)
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
