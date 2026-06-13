import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { LtvService } from '@/lib/ltv/LtvService'

const service = new LtvService()

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'settings', 'read')
  if (!auth.ok) return auth.response

  try {
    const data = await service.getDistribution()
    return NextResponse.json({ data })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
