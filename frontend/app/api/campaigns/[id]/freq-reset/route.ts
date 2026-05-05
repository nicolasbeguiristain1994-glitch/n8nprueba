import { NextResponse }                    from 'next/server'
import { query }                           from '@/lib/db'
import { isUUID }                          from '@/lib/validate'
import { checkPermissionWithUser }         from '@/lib/permissions'
import { audit }                           from '@/lib/audit'

// DELETE /api/campaigns/[id]/freq-reset
//
// Borra el historial de frecuencia de los contactos que participaron en
// esta campaña. Útil para entornos de prueba: permite volver a enviar a
// los mismos contactos sin esperar el cooldown de 48h.
//
// También resetea campaign_recipients de 'skipped' a 'pending' para que
// la campaña pueda re-ejecutarse si aún está en estado paused/running.
//
// Acceso: solo admin.

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'manage')
  if (!auth.ok) return auth.response
  if (auth.user.role !== 'admin') {
    return NextResponse.json({ error: 'Solo administradores pueden limpiar historial de frecuencia' }, { status: 403 })
  }

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const [campaign] = await query<{ id: string; name: string; status: string }>(
    'SELECT id, name, status FROM campaigns WHERE id = $1', [id]
  )
  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

  try {
    // 1. Borrar historial de frecuencia de esta campaña
    const [deleted] = await query<{ count: string }>(
      `WITH del AS (
         DELETE FROM contact_send_history
         WHERE campaign_id = $1
            OR campaign_recipient_id IN (
                 SELECT id FROM campaign_recipients WHERE campaign_id = $1
               )
         RETURNING id
       )
       SELECT COUNT(*)::text AS count FROM del`,
      [id]
    )

    // 2. Resetear TODOS los recipients (sent/failed/skipped) → pending para re-envío de prueba
    const [reset] = await query<{ count: string }>(
      `WITH upd AS (
         UPDATE campaign_recipients
         SET status            = 'pending',
             locked_at         = NULL,
             line_id           = NULL,
             error_detail      = NULL,
             sent_at           = NULL,
             failed_at         = NULL,
             evolution_message_id = NULL,
             message_body      = NULL,
             attempts          = 0,
             updated_at        = NOW()
         WHERE campaign_id = $1
           AND status IN ('sent', 'failed', 'skipped')
         RETURNING id
       )
       SELECT COUNT(*)::text AS count FROM upd`,
      [id]
    )

    // 3. Resetear la campaña a 'paused' (estado reanudable) y limpiar contadores
    await query(
      `UPDATE campaigns
       SET status       = 'paused',
           total_sent   = 0,
           total_failed = 0,
           completed_at = NULL,
           updated_at   = NOW()
       WHERE id = $1
         AND status IN ('completed', 'cancelled', 'paused', 'running')`,
      [id]
    )

    const deletedCount = Number(deleted?.count || 0)
    const resetCount   = Number(reset?.count   || 0)

    void audit({
      req,
      action:      'manage',
      resource:    'campaigns',
      resource_id: id,
      metadata:    { action: 'freq_reset_full', deleted_history: deletedCount, reset_recipients: resetCount },
    })

    return NextResponse.json({
      ok:                true,
      deleted_history:   deletedCount,
      reset_recipients:  resetCount,
    })
  } catch (e) {
    console.error('[DELETE /campaigns/[id]/freq-reset]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
