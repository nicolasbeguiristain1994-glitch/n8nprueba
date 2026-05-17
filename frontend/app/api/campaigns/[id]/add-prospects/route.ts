import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermission } from '@/lib/permissions'

// POST /api/campaigns/[id]/add-prospects
//
// Agrega prospectos como destinatarios de una campaña existente.
// Inserta filas en campaign_recipients con prospect_id (no contact_id).
//
// Body: {
//   prospect_ids: string[]     // UUIDs de prospectos a agregar
//   batch_id?:   string        // alternativa: agregar todo un batch
// }
//
// Comportamiento idempotente: ON CONFLICT DO NOTHING.
// Retorna: { added, already_in_campaign, skipped_inactive }

type Params = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  const err = await checkPermission(req, 'contacts', 'manage')
  if (err) return err

  const { id: campaignId } = await params
  if (!isUUID(campaignId)) return NextResponse.json({ error: 'Invalid campaign id' }, { status: 400 })

  let body: { prospect_ids?: string[]; batch_id?: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { prospect_ids, batch_id } = body

  if (!prospect_ids?.length && !batch_id) {
    return NextResponse.json({ error: 'Requerido: prospect_ids o batch_id' }, { status: 400 })
  }
  if (batch_id && !isUUID(batch_id)) {
    return NextResponse.json({ error: 'Invalid batch_id' }, { status: 400 })
  }
  if (prospect_ids && prospect_ids.some(id => !isUUID(id))) {
    return NextResponse.json({ error: 'prospect_ids contiene UUIDs inválidos' }, { status: 400 })
  }

  // Verificar que la campaña existe
  const [campaign] = await query<{ id: string; status: string }>(
    `SELECT id, status FROM campaigns WHERE id = $1`,
    [campaignId]
  )
  if (!campaign) return NextResponse.json({ error: 'Campaña no encontrada' }, { status: 404 })
  if (['sent', 'cancelled'].includes(campaign.status)) {
    return NextResponse.json({ error: `No se pueden agregar destinatarios a una campaña ${campaign.status}` }, { status: 409 })
  }

  try {
    // Contar cuántos ya están en la campaña antes de insertar
    const alreadyFilter = prospect_ids?.length
      ? `AND p.id = ANY($2::uuid[])`
      : `AND p.import_batch_id = $2::uuid`
    const alreadyParam = prospect_ids?.length ? prospect_ids : [batch_id]

    const [existing] = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM campaign_recipients cr
       JOIN prospects p ON p.id = cr.prospect_id
       WHERE cr.campaign_id = $1 ${alreadyFilter}`,
      [campaignId, ...alreadyParam]
    )
    const alreadyInCampaign = Number(existing?.count ?? 0)

    // Insertar: solo prospectos activos con opt_in = true, no en blacklist
    const insertFilter = prospect_ids?.length
      ? `AND p.id = ANY($2::uuid[])`
      : `AND p.import_batch_id = $2::uuid`

    const [ins] = await query<{ inserted: string }>(
      `WITH ins AS (
         INSERT INTO campaign_recipients (campaign_id, prospect_id, phone_number)
         SELECT $1, p.id, p.phone_number
         FROM prospects p
         WHERE p.status  = 'active'
           AND p.opt_in  = true
           ${insertFilter}
           AND NOT EXISTS (
             SELECT 1 FROM blacklist bl
             WHERE bl.phone_number_normalized = regexp_replace(p.phone_number, '[^0-9]', '', 'g')
               AND bl.removed_at IS NULL
           )
         ON CONFLICT DO NOTHING
         RETURNING id
       )
       SELECT COUNT(*)::text AS inserted FROM ins`,
      [campaignId, ...(prospect_ids?.length ? [prospect_ids] : [batch_id])]
    )
    const added = Number(ins?.inserted ?? 0)

    // Actualizar total_targets en la campaña
    await query(
      `UPDATE campaigns
       SET total_targets = (
         SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = $1
       ),
       updated_at = NOW()
       WHERE id = $1`,
      [campaignId]
    )

    return NextResponse.json({ added, already_in_campaign: alreadyInCampaign })
  } catch (e) {
    console.error('[POST /api/campaigns/[id]/add-prospects]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
