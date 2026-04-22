import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission, isCampaignOwnerOrAdmin } from '@/lib/permissions'
import { getSessionFromRequest } from '@/lib/auth'
import { audit } from '@/lib/audit'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const err = checkPermission(req, 'campaigns', 'update')
  if (err) return err

  const session = getSessionFromRequest(req)!  // safe: checkPermission already verified
  const { id } = await params

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

    await query(
      `UPDATE campaigns
       SET status = $1::campaign_status, updated_at = NOW(), updated_by = $3
       WHERE id = $2`,
      [status, id, session.user_id]
    )
    void audit({ req, action: 'update', resource: 'campaigns', resource_id: id,
      metadata: { status } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/campaigns PATCH]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
