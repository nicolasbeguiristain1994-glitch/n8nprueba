import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser, isCampaignOwnerOrAdmin } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { clog } from '@/lib/campaign-logger'
import { parseBody, handleValidationError, UpdateCampaignStatusSchema } from '@/lib/schema'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'update')
  if (!auth.ok) return auth.response

  const session = auth.user
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(UpdateCampaignStatusSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'campaigns')

  const { status } = parsed.data

  try {
    const [row] = await query<{ owned_by: string | null; status: string; is_priority_broadcast?: boolean }>(
      'SELECT owned_by, status, is_priority_broadcast FROM campaigns WHERE id = $1', [id]
    )
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!isCampaignOwnerOrAdmin(session, row.owned_by))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const allowedFrom = {
      paused: ['scheduled', 'running', 'paused'],
      cancelled: ['draft', 'scheduled', 'running', 'paused', 'cancelled', ...(row.is_priority_broadcast ? ['completed'] : [])],
      draft: ['draft', 'scheduled'],
    }
    if (!allowedFrom[status].includes(row.status)) {
      return NextResponse.json({ error: `No se puede cambiar una campaña ${row.status} a ${status}` }, { status: 409 })
    }
    if (row.status === status) return NextResponse.json({ ok: true, changed: false })

    const updated = await query<{ id: string }>(
      `UPDATE campaigns
       SET status       = $1::campaign_status,
           pause_reason = CASE WHEN $1 = 'paused' THEN 'manual' ELSE NULL END,
           scheduled_at = CASE WHEN $1 = 'draft' THEN NULL ELSE scheduled_at END,
           updated_at   = NOW(),
           updated_by   = $3
       WHERE id = $2 AND status = $4::campaign_status
         AND owned_by IS NOT DISTINCT FROM $5::uuid
       RETURNING id`,
      [status, id, session.user_id, row.status, row.owned_by]
    )
    if (!updated[0]) return NextResponse.json({ error: 'La campaña cambió; actualizá antes de volver a intentar' }, { status: 409 })

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
