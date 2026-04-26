import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser } from '@/lib/permissions'
import { query } from '@/lib/db'
import { repopularListasCasino } from '@/lib/casino-lists'
import { audit } from '@/lib/audit'

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'lists', 'manage')
  if (!auth.ok) return auth.response

  // manage is admin-only by RBAC — belt-and-suspenders check
  if (auth.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    // Resolve admin owner id for list ownership
    const adminRows = await query<{ id: string }>(
      `SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`,
    )
    const ownerId = adminRows[0]?.id ?? null

    const result = await repopularListasCasino(ownerId)

    void audit({
      req,
      action:    'create',
      resource:  'lists',
      metadata:  { action: 'casino_repopulate', total_lists: result.total_lists, timestamp: result.timestamp },
    })

    return NextResponse.json({ success: true, ...result })
  } catch (e) {
    console.error('[/api/lists/casino/repopulate POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
