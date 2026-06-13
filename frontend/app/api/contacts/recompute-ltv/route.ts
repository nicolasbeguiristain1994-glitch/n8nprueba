import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { LtvService, LtvRecomputeAlreadyRunningError } from '@/lib/ltv/LtvService'

const service = new LtvService()

export async function POST(req: NextRequest) {
  const cronSecret = req.headers.get('x-cron-secret')
  const isCronCall = cronSecret && process.env.CRON_SECRET && cronSecret === process.env.CRON_SECRET

  if (!isCronCall) {
    const auth = await checkPermissionWithUser(req, 'contacts', 'manage')
    if (!auth.ok) return auth.response
  }

  try {
    const result = await service.recomputeAll()

    void audit({
      req,
      action:   'recompute',
      resource: 'player_ltv',
      status:   'success',
      metadata: result as unknown as Record<string, unknown>,
    })

    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof LtvRecomputeAlreadyRunningError) {
      return NextResponse.json({ error: err.message }, { status: 409 })
    }
    throw err
  }
}
