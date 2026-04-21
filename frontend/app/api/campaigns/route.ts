import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID, clampStr } from '@/lib/validate'

export async function GET() {
  try {
    const campaigns = await query(`
      SELECT c.id, c.name, c.message, c.messages, c.status, c.scheduled_at,
             c.started_at, c.completed_at,
             c.total_targets, c.personalize_name,
             c.antiblock_delay_min, c.antiblock_delay_max,
             c.created_at, cl.name AS list_name,
             -- Contar directamente desde whatsapp_messages para precisión en tiempo real
             COUNT(m.id) FILTER (WHERE m.status IN ('sent','delivered','read'))::int AS total_sent,
             COUNT(m.id) FILTER (WHERE m.status = 'delivered')::int               AS total_delivered,
             COUNT(m.id) FILTER (WHERE m.status = 'read')::int                    AS total_read,
             COUNT(m.id) FILTER (WHERE m.status = 'failed')::int                  AS total_failed,
             CASE WHEN COUNT(m.id) FILTER (WHERE m.status IN ('sent','delivered','read')) > 0
               THEN ROUND(COUNT(m.id) FILTER (WHERE m.status = 'read')::numeric /
                          COUNT(m.id) FILTER (WHERE m.status IN ('sent','delivered','read')) * 100, 1)
               ELSE 0 END AS read_rate,
             CASE WHEN c.total_targets > 0
               THEN ROUND(COUNT(m.id) FILTER (WHERE m.status IN ('sent','delivered','read'))::numeric /
                          c.total_targets * 100, 1)
               ELSE 0 END AS delivery_rate
      FROM campaigns c
      LEFT JOIN contact_lists cl ON cl.id = c.list_id
      LEFT JOIN whatsapp_messages m ON m.campaign_id = c.id
      GROUP BY c.id, cl.name
      ORDER BY c.created_at DESC
    `)
    return NextResponse.json({ campaigns })
  } catch (e) {
    console.error('[/api/campaigns GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let body: {
    name?: string; message?: string; messages?: string[]; media_url?: string; media_type?: string
    list_id?: string; scheduled_at?: string; antiblock_delay_min?: number; antiblock_delay_max?: number
    type?: string; personalize_name?: boolean
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { name, message, messages, media_url, media_type, list_id, scheduled_at,
          antiblock_delay_min, antiblock_delay_max, type: campaignType,
          personalize_name } = body

  const nameStr = clampStr(name, 255)
  if (!nameStr)
    return NextResponse.json({ error: 'name es requerido y no puede estar vacío' }, { status: 400 })

  // messages[] takes priority; fall back to single message
  const rawMsgs = Array.isArray(messages) ? messages : (message ? [message] : [])
  if (rawMsgs.length === 0 || rawMsgs.length > 10)
    return NextResponse.json({ error: 'Se requiere entre 1 y 10 mensajes' }, { status: 400 })
  const msgArray: string[] = rawMsgs
    .map((m: unknown) => clampStr(m, 4096))
    .filter((m): m is string => m !== null && m.length > 0)
  if (msgArray.length === 0)
    return NextResponse.json({ error: 'Al menos un mensaje debe ser no vacío' }, { status: 400 })

  if (list_id !== undefined && list_id !== null && !isUUID(list_id))
    return NextResponse.json({ error: 'list_id debe ser un UUID válido' }, { status: 400 })

  const delayMin = antiblock_delay_min !== undefined ? Number(antiblock_delay_min) : 3
  const delayMax = antiblock_delay_max !== undefined ? Number(antiblock_delay_max) : 8
  if (!Number.isFinite(delayMin) || delayMin < 1)
    return NextResponse.json({ error: 'antiblock_delay_min debe ser un número positivo' }, { status: 400 })
  if (!Number.isFinite(delayMax) || delayMax < 1)
    return NextResponse.json({ error: 'antiblock_delay_max debe ser un número positivo' }, { status: 400 })
  if (delayMin > delayMax)
    return NextResponse.json({ error: 'antiblock_delay_min no puede ser mayor que antiblock_delay_max' }, { status: 400 })

  const ALLOWED_TYPES = ['promotion', 'retention', 'onboarding', 'support', 'survey', 'payment', 'risk_alert']
  const resolvedType = campaignType || 'promotion'
  if (!ALLOWED_TYPES.includes(resolvedType))
    return NextResponse.json({ error: `Tipo de campaña inválido. Valores permitidos: ${ALLOWED_TYPES.join(', ')}` }, { status: 400 })

  try {
    let total_targets = 0
    if (list_id) {
      const [r] = await query<{ count: string }>(
        'SELECT COUNT(*)::int AS count FROM contact_list_members WHERE list_id = $1', [list_id]
      )
      total_targets = Number(r?.count || 0)
    }

    const [campaign] = await query<{ id: string }>(
      `INSERT INTO campaigns
         (name, message, messages, media_url, media_type, list_id, type, status, scheduled_at,
          total_targets, antiblock_delay_min, antiblock_delay_max, personalize_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [nameStr, msgArray[0], JSON.stringify(msgArray), media_url || null, media_type || null,
       list_id || null, resolvedType,
       scheduled_at ? 'scheduled' : 'draft',
       scheduled_at || null, total_targets,
       delayMin, delayMax,
       personalize_name !== false]
    )

    return NextResponse.json({ id: campaign.id, name: nameStr, status: scheduled_at ? 'scheduled' : 'draft' })
  } catch (e) {
    console.error('[/api/campaigns POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
