// GET /api/distributor/stats
//
// Returns fleet-level stats: line eligibility counts and proxy health summary.
//
// Requires: lines:read

import { NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { getDistributorStats } from '@/lib/distributor'

export async function GET(req: Request) {
  const err = await checkPermission(req, 'lines', 'read')
  if (err) return err

  try {
    const stats = await getDistributorStats()
    return NextResponse.json(stats)
  } catch (e) {
    console.error('[/api/distributor/stats GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
