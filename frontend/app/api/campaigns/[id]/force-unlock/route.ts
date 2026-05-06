import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { clog } from '@/lib/campaign-logger'

// ── POST /api/campaigns/[id]/force-unlock ─────────────────────────────────────
// Admin-only endpoint to forcibly release a stale processor lock.
//
// Use case: a processor crashed or was killed and left the lock held, preventing
// the campaign from being restarted until PROCESSOR_LOCK_MINUTES (30 min) expire.
//
// Safety:
//   - Requires admin role — operators cannot accidentally kill a live processor.
//   - Only releases the lock if the campaign is in 'running' or 'paused' state.
//   - Sets status to 'paused' (not running) — a human must explicitly restart it.
//   - If the original processor is still alive it will fail its next heartbeat
//     (processor_lock_token won't match) and release cleanly on its own.
//   - Full audit trail via audit() + clog.critical event.
//
// Access: admin role only (campaigns:update permission gated further by role check)

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'update')
  if (!auth.ok) return auth.response

  if (auth.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })
  }

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  try {
    const [before] = await query<{
      status: string
      processor_locked_at: string | null
      processor_lock_token: string | null
    }>(
      `SELECT status, processor_locked_at, processor_lock_token
       FROM campaigns WHERE id = $1`,
      [id]
    )

    if (!before) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

    const unlockableStatuses = ['running', 'paused']
    if (!unlockableStatuses.includes(before.status)) {
      return NextResponse.json(
        { error: `Campaign is ${before.status} — nothing to unlock` },
        { status: 409 }
      )
    }

    if (!before.processor_lock_token && !before.processor_locked_at) {
      return NextResponse.json(
        { ok: true, message: 'Lock was already released', changed: false }
      )
    }

    const [updated] = await query<{ id: string }>(
      `UPDATE campaigns
       SET status               = 'paused',
           pause_reason         = 'manual',
           processor_locked_at  = NULL,
           processor_lock_token = NULL,
           updated_at           = NOW(),
           updated_by           = $2
       WHERE id = $1
       RETURNING id`,
      [id, auth.user.user_id]
    )

    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    clog.critical({
      event:      'lock.force_released',
      campaignId: id,
      adminId:    auth.user.user_id,
      wasStatus:  before.status,
      lockedSince: before.processor_locked_at,
      detail:     'lock released by admin via force-unlock endpoint',
    })

    void audit({
      req,
      action:    'update',
      resource:  'campaigns',
      resource_id: id,
      metadata: {
        action:      'force_unlock',
        was_status:  before.status,
        locked_since: before.processor_locked_at,
      },
    })

    return NextResponse.json({
      ok:      true,
      message: 'Lock released. Campaign set to paused — restart it manually.',
      changed: true,
    })
  } catch (e) {
    console.error('[POST /api/campaigns/[id]/force-unlock]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
