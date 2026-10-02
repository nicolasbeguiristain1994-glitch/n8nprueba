import { NextResponse } from 'next/server'
import { withTransaction } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser, isCampaignOwnerOrAdmin } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { prepareCampaignRetry } from '@/lib/campaign-retry'

// Only definite failures may be retried. Ambiguous provider outcomes require
// reconciliation, even when a recipient has already been labelled "failed".
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'send', 'send')
  if (!auth.ok) return auth.response
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  try {
    const result = await withTransaction(async client => {
      const { rows: [campaign] } = await client.query<{
        owned_by: string | null; status: string; has_lock: boolean
      }>(`SELECT owned_by, status,
            (processor_locked_at IS NOT NULL OR processor_lock_token IS NOT NULL) AS has_lock
          FROM campaigns WHERE id = $1 FOR UPDATE`, [id])
      if (!campaign) return { status: 404, body: { error: 'Campaign not found' } }
      if (!isCampaignOwnerOrAdmin(auth.user, campaign.owned_by))
        return { status: 403, body: { error: 'Forbidden' } }
      if (!['completed', 'paused'].includes(campaign.status) || campaign.has_lock)
        return { status: 409, body: { error: 'Pausá la campaña y esperá a que termine el procesador antes de reintentar' } }

      const resetCount = await prepareCampaignRetry(client, id)
      if (!resetCount) return { status: 409, body: {
        error: 'No hay fallos confirmados ni omitidos por frecuencia para reintentar. Los mensajes entregados o pendientes de confirmación se conservan.',
      } }
      await client.query(
        `UPDATE campaigns SET status = 'paused', pause_reason = 'manual', completed_at = NULL,
           total_sent = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = $1 AND status = 'sent'),
           total_failed = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = $1 AND status = 'failed'),
           total_skipped = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = $1 AND status = 'skipped'),
           updated_at = NOW(), updated_by = $2
         WHERE id = $1`, [id, auth.user.user_id]
      )
      return { status: 200, body: { ok: true, reset_count: resetCount } }
    })
    if (result.status === 200) void audit({ req, action: 'send', resource: 'campaigns', resource_id: id,
      metadata: { action: 'retry_failed', reset_count: result.body.reset_count } })
    return NextResponse.json(result.body, { status: result.status })
  } catch (error) {
    console.error('[POST /campaigns/[id]/retry-failed]', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
