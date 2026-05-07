import { NextResponse }                    from 'next/server'
import { query }                           from '@/lib/db'
import { isUUID }                          from '@/lib/validate'
import { checkPermissionWithUser, isCampaignOwnerOrAdmin } from '@/lib/permissions'
import { audit }                           from '@/lib/audit'

// POST /api/campaigns/[id]/retry-failed
//
// Resetea SOLO los recipients con status='failed' a 'pending' para reintento.
// Los recipients con status='sent' NO se tocan — no se re-envía a nadie que ya recibió.
// Cambia el estado de la campaña a 'paused' para que sea reanudable.
//
// Acceso: dueño de la campaña o admin.

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'send', 'send')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const [campaign] = await query<{ id: string; name: string; status: string; owned_by: string | null }>(
    'SELECT id, name, status, owned_by FROM campaigns WHERE id = $1', [id]
  )
  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

  if (!isCampaignOwnerOrAdmin(auth.user, campaign.owned_by)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const RETRYABLE = ['completed', 'paused', 'running', 'cancelled']
  if (!RETRYABLE.includes(campaign.status)) {
    return NextResponse.json(
      { error: `La campaña está en estado "${campaign.status}" y no se puede reintentar` },
      { status: 409 }
    )
  }

  try {
    // 1. Contar fallidos antes de resetear
    const [countRow] = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM campaign_recipients WHERE campaign_id = $1 AND status = 'failed'`,
      [id]
    )
    const failedCount = Number(countRow?.count || 0)

    if (failedCount === 0) {
      return NextResponse.json({ error: 'No hay contactos fallidos para reintentar' }, { status: 400 })
    }

    // 2. Resetear SOLO los failed → pending (sent/skipped no se tocan)
    await query(
      `UPDATE campaign_recipients
       SET status       = 'pending',
           locked_at    = NULL,
           line_id      = NULL,
           error_detail = NULL,
           failed_at    = NULL,
           attempts     = 0,
           updated_at   = NOW()
       WHERE campaign_id = $1
         AND status = 'failed'`,
      [id]
    )

    // 3. Pasar la campaña a 'paused' para que sea reanudable
    //    Limpiar el lock por si quedó colgado
    await query(
      `UPDATE campaigns
       SET status                = 'paused',
           processor_locked_at  = NULL,
           processor_lock_token = NULL,
           updated_at           = NOW()
       WHERE id = $1
         AND status NOT IN ('draft', 'scheduled')`,
      [id]
    )

    void audit({
      req,
      action:      'send',
      resource:    'campaigns',
      resource_id: id,
      metadata:    { action: 'retry_failed', reset_count: failedCount },
    })

    return NextResponse.json({ ok: true, reset_count: failedCount })
  } catch (e) {
    console.error('[POST /campaigns/[id]/retry-failed]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
