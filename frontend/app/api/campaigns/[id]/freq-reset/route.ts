import { NextResponse } from 'next/server'
import { withTransaction } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'

// Legacy test reset. Accepted or ambiguous attempts retain their original fences
// and history; re-sending those recipients requires a separate campaign.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'manage')
  if (!auth.ok) return auth.response
  if (auth.user.role !== 'admin')
    return NextResponse.json({ error: 'Solo administradores pueden reiniciar una campaña' }, { status: 403 })
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  const body = await req.json().catch(() => null)
  if (body?.confirm_reset !== true)
    return NextResponse.json({ error: 'Confirmá explícitamente el reinicio de destinatarios no enviados' }, { status: 400 })

  try {
    const result = await withTransaction(async client => {
      const { rows: [campaign] } = await client.query<{ status: string; has_lock: boolean }>(
        `SELECT status, (processor_locked_at IS NOT NULL OR processor_lock_token IS NOT NULL) AS has_lock
         FROM campaigns WHERE id = $1 FOR UPDATE`, [id])
      if (!campaign) return { status: 404, body: { error: 'Campaign not found' } }
      if (!['paused', 'completed', 'cancelled'].includes(campaign.status) || campaign.has_lock)
        return { status: 409, body: { error: 'Pausá la campaña y esperá a que termine el procesador antes de reiniciarla' } }

      // Serialize against recipient updates and late status callbacks. A failed
      // campaign does not imply that the provider rejected every message.
      const { rows: recipients } = await client.query<{
        status: string; locked_at: string | null; evolution_message_id: string | null; error_detail: string | null
      }>(`SELECT status, locked_at, evolution_message_id, error_detail
          FROM campaign_recipients WHERE campaign_id = $1 FOR UPDATE`, [id])
      if (recipients.some(row => row.status === 'sending' || row.locked_at !== null))
        return { status: 409, body: { error: 'Todavía hay destinatarios en procesamiento; no se puede reiniciar' } }
      const { rows: messages } = await client.query<{
        status: string; evolution_message_id: string | null; error_detail: string | null
      }>(`SELECT status, evolution_message_id, error_detail FROM whatsapp_messages
          WHERE campaign_id = $1 OR campaign_recipient_id IN (
            SELECT id FROM campaign_recipients WHERE campaign_id = $1
          ) FOR UPDATE`, [id])
      const ambiguous = (row: { evolution_message_id: string | null; error_detail: string | null }) =>
        row.evolution_message_id !== null ||
        (row.error_detail ?? '').startsWith('[provider-outcome-unknown-no-resend]') ||
        (row.error_detail ?? '').startsWith('stale-queued-no-resend')
      const { rows: [history] } = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM contact_send_history WHERE campaign_id = $1
          OR campaign_recipient_id IN (SELECT id FROM campaign_recipients WHERE campaign_id = $1)) AS exists`, [id])
      if (history?.exists || recipients.some(row => row.status === 'sent' || ambiguous(row)) ||
          messages.some(row => ['queued', 'sent', 'delivered', 'read'].includes(row.status) || ambiguous(row)))
        return { status: 409, body: { error: 'Hay envíos aceptados o pendientes de confirmación. Se conservan sus registros; creá una campaña nueva si necesitás reenviarlos.' } }

      const { rows: [reset] } = await client.query<{ count: string }>(
        `WITH upd AS (
           UPDATE campaign_recipients SET status = 'pending', locked_at = NULL, line_id = NULL,
             error_detail = NULL, sent_at = NULL, failed_at = NULL, message_body = NULL,
             attempts = 0, updated_at = NOW()
           WHERE campaign_id = $1 AND status IN ('pending', 'failed', 'skipped') RETURNING id
         ) SELECT COUNT(*)::text AS count FROM upd`, [id])
      await client.query(
        `UPDATE campaigns SET status = 'paused', pause_reason = 'manual', completed_at = NULL,
           total_sent = 0, total_failed = 0, total_skipped = 0, updated_at = NOW(), updated_by = $2
         WHERE id = $1`, [id, auth.user.user_id])
      return { status: 200, body: { ok: true, deleted_history: 0, reset_recipients: Number(reset?.count ?? 0) } }
    })
    if (result.status === 200) void audit({ req, action: 'manage', resource: 'campaigns', resource_id: id,
      metadata: { action: 'freq_reset_definite_failures', reset_recipients: result.body.reset_recipients, accepted_fences_preserved: true } })
    return NextResponse.json(result.body, { status: result.status })
  } catch (error) {
    console.error('[DELETE /campaigns/[id]/freq-reset]', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'No se pudo reiniciar la campaña; no se aplicó el reinicio' }, { status: 500 })
  }
}
