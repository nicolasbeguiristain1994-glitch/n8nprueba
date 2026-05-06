import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser, isCampaignOwnerOrAdmin } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { clog } from '@/lib/campaign-logger'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'update')
  if (!auth.ok) return auth.response

  const session = auth.user
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  let body: { status?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { status } = body

  const allowed = ['paused', 'cancelled', 'draft']
  if (!status || !allowed.includes(status)) {
    return NextResponse.json({ error: 'Status inválido' }, { status: 400 })
  }

  try {
    // Ownership check for non-admin users
    if (session.role !== 'admin') {
      const [row] = await query<{ owned_by: string | null }>(
        'SELECT owned_by FROM campaigns WHERE id = $1', [id]
      )
      if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      if (!isCampaignOwnerOrAdmin(session, row.owned_by))
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const updated = await query<{ id: string }>(
      `UPDATE campaigns
       SET status       = $1::campaign_status,
           pause_reason = CASE WHEN $1 = 'paused' THEN 'manual' ELSE NULL END,
           updated_at   = NOW(),
           updated_by   = $3
       WHERE id = $2
       RETURNING id`,
      [status, id, session.user_id]
    )
    if (!updated[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if (status === 'paused') {
      clog.info({ event: 'campaign.paused', campaignId: id, reason: 'manual' })
    } else if (status === 'cancelled') {
      clog.info({ event: 'campaign.cancelled', campaignId: id })
    }

    void audit({ req, action: 'update', resource: 'campaigns', resource_id: id,
      metadata: { status } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/campaigns PATCH]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
