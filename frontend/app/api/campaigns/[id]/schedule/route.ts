import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser, isCampaignOwnerOrAdmin } from '@/lib/permissions'
import { normalizeCampaignSchedule } from '@/lib/campaign-template'
import { parseBody, handleValidationError } from '@/lib/schema'
import { audit } from '@/lib/audit'

const ScheduleSchema = z.object({
  scheduled_at: z.string().trim().min(1).max(40),
  expected_scheduled_at: z.string().trim().min(1).max(40),
}).strict()

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'update')
  if (!auth.ok) return auth.response
  const sendAuth = await checkPermissionWithUser(req, 'send', 'send')
  if (!sendAuth.ok) return sendAuth.response
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  const parsed = parseBody(ScheduleSchema, await req.json().catch(() => null))
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'campaigns')

  let schedule: string | null, expected: string | null
  try {
    schedule = normalizeCampaignSchedule(parsed.data.scheduled_at)
    expected = normalizeCampaignSchedule(parsed.data.expected_scheduled_at)
  } catch {
    return NextResponse.json({ error: 'Fecha de programación inválida' }, { status: 400 })
  }
  if (!schedule || !expected || Date.parse(schedule) <= Date.now()) {
    return NextResponse.json({ error: 'La fecha programada debe estar en el futuro' }, { status: 400 })
  }
  if (process.env.CAMPAIGN_SCHEDULER_ENABLED !== 'true' || !process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'La programación automática no está habilitada' }, { status: 409 })
  }

  try {
    const [campaign] = await query<{
      owned_by: string | null; status: string; started_at: Date | null
      processor_locked_at: Date | null; processor_lock_token: string | null
    }>(`SELECT owned_by, status, started_at, processor_locked_at, processor_lock_token
        FROM campaigns WHERE id = $1`, [id])
    if (!campaign) return NextResponse.json({ error: 'Campaña no encontrada' }, { status: 404 })
    if (!isCampaignOwnerOrAdmin(auth.user, campaign.owned_by)) {
      return NextResponse.json({ error: 'No tenés permiso para editar esta campaña' }, { status: 403 })
    }
    if (campaign.status !== 'scheduled' || campaign.started_at || campaign.processor_locked_at || campaign.processor_lock_token) {
      return NextResponse.json({ error: 'Solo se puede editar el horario de una campaña programada que todavía no empezó a enviarse' }, { status: 409 })
    }

    // Competes atomically with the scheduler/manual send claim. The previous
    // timestamp also prevents an old dialog from overwriting a newer schedule.
    const [updated] = await query<{ scheduled_at: Date }>(
      `UPDATE campaigns SET scheduled_at = $2::timestamptz, updated_at = NOW(), updated_by = $3
       WHERE id = $1 AND status = 'scheduled' AND started_at IS NULL
         AND processor_locked_at IS NULL AND processor_lock_token IS NULL
         AND owned_by IS NOT DISTINCT FROM $4::uuid
         AND scheduled_at = $5::timestamptz AND $2::timestamptz > clock_timestamp()
       RETURNING scheduled_at`,
      [id, schedule, auth.user.user_id, campaign.owned_by, expected],
    )
    if (!updated) {
      return NextResponse.json({ error: 'La campaña cambió o la nueva hora ya pasó. Cerrá este cuadro y volvé a abrir Editar horario para revisar los datos actuales.' }, { status: 409 })
    }
    void audit({ req, action: 'update', resource: 'campaigns', resource_id: id,
      metadata: { previous_scheduled_at: expected, scheduled_at: schedule } })
    return NextResponse.json({ ok: true, scheduled_at: updated.scheduled_at })
  } catch (error) {
    console.error('[/api/campaigns/schedule PATCH]', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'No se pudo actualizar el horario' }, { status: 500 })
  }
}
