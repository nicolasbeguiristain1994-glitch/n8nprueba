import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'read')
  if (!auth.ok) return auth.response

  try {
    const profiles = await query<{
      id: string; profile_name: string; is_default: boolean
      timing_mode: string; risk_tolerance: string; recommended_for: string | null
    }>(
      `SELECT id, profile_name, is_default, timing_mode, risk_tolerance, recommended_for
       FROM anti_ban_profiles
       ORDER BY is_default DESC, profile_name ASC`
    )
    return NextResponse.json({ profiles })
  } catch (e) {
    console.error('[/api/anti-ban-profiles GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
