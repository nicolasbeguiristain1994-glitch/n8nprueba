import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { getAllWithSource } from '@/lib/scoring-config-service'

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'settings', 'read')
  if (!auth.ok) return auth.response

  try {
    const { config, source } = await getAllWithSource()
    return NextResponse.json({ config, source })
  } catch (e) {
    console.error('[/api/settings/scoring GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
