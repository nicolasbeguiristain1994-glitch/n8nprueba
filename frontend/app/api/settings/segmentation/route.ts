import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { getAllTiersWithSource } from '@/lib/segmentation-config-service'

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'settings', 'read')
  if (!auth.ok) return auth.response

  try {
    const { tiers, source } = await getAllTiersWithSource()
    return NextResponse.json({ tiers, source })
  } catch (e) {
    console.error('[/api/settings/segmentation GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
