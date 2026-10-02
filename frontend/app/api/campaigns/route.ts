import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser, isOwnerOrAdmin } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { parseBody, handleValidationError, CreateCampaignSchema } from '@/lib/schema'
import { normalizeCampaignSchedule, validateCampaignTemplate } from '@/lib/campaign-template'
import { getAccessibleLineIds } from '@/lib/line-visibility'
import { CAMPAIGN_STATS_SQL } from '@/lib/campaign-stats'

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'read')
  if (!auth.ok) return auth.response

  const session = auth.user
  const isAdmin = session.role === 'admin'

  try {
    // Admin sees everything (including historical rows where owned_by IS NULL).
    // Operator/viewer see only their own campaigns; NULL-owned historical rows
    // are admin-only and never appear in non-admin lists.
    const ownerClause = isAdmin ? '' : 'WHERE c.owned_by = $1'
    const params      = isAdmin ? [] : [session.user_id]

    const campaignSql = (includePauseReason: boolean, includeProspectList: boolean) => `
      SELECT c.id, c.name, c.message, c.messages, c.status, c.scheduled_at,
             c.started_at, c.completed_at,
             c.total_targets, c.personalize_name,
             c.antiblock_delay_min, c.antiblock_delay_max,
             c.use_multi_line, c.message_type, c.template_id, c.template_params,
             (SELECT wt.name FROM whatsapp_templates wt WHERE wt.id=c.template_id) AS template_name,
             ${includePauseReason ? 'c.pause_reason,' : 'NULL::text AS pause_reason,'}
             c.processor_locked_at,
             c.created_at, c.owned_by, cl.name AS list_name, cl.id AS list_id,
             ${includeProspectList ? 'c.prospect_list_id, pl.name AS prospect_list_name,' : 'NULL::uuid AS prospect_list_id, NULL::text AS prospect_list_name,'}
             stats.sent AS total_sent, stats.delivered AS total_delivered,
             stats.read AS total_read, stats.failed AS total_failed, stats.skipped AS total_skipped,
             CASE WHEN stats.sent>0 THEN ROUND(stats.read::numeric/stats.sent*100,1) ELSE 0 END AS read_rate,
             CASE WHEN c.total_targets>0 THEN ROUND(stats.delivered::numeric/c.total_targets*100,1) ELSE 0 END AS delivery_rate
      FROM campaigns c
      LEFT JOIN contact_lists cl ON cl.id = c.list_id
      ${includeProspectList ? 'LEFT JOIN prospect_lists pl ON pl.id = c.prospect_list_id' : ''}
      LEFT JOIN LATERAL (${CAMPAIGN_STATS_SQL}) stats ON true
      ${ownerClause}
      ORDER BY c.created_at DESC
    `

    let campaigns
    try {
      campaigns = await query(campaignSql(true, true), params)
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      // Fallback 1: prospect_lists table missing (migración 096/097 no aplicada)
      if (msg.includes('prospect_list') || msg.includes('relation "prospect_lists"')) {
        console.warn('[/api/campaigns GET] prospect_lists missing — running without it. Apply migrations 096/097.')
        try {
          campaigns = await query(campaignSql(true, false), params)
        } catch (e2) {
          const msg2 = e2 instanceof Error ? e2.message : ''
          // Fallback 2: pause_reason missing (migración 054 no aplicada)
          if (msg2.includes('pause_reason') || msg2.includes('column')) {
            console.warn('[/api/campaigns GET] pause_reason column missing — running without it. Apply migration 054.')
            campaigns = await query(campaignSql(false, false), params)
          } else {
            throw e2
          }
        }
      // Fallback 2: pause_reason missing (migración 054 no aplicada)
      } else if (msg.includes('pause_reason') || msg.includes('column')) {
        console.warn('[/api/campaigns GET] pause_reason column missing — running without it. Apply migration 054.')
        try {
          campaigns = await query(campaignSql(false, true), params)
        } catch {
          campaigns = await query(campaignSql(false, false), params)
        }
      } else {
        throw e
      }
    }

    return NextResponse.json({ campaigns, scheduler_enabled: process.env.CAMPAIGN_SCHEDULER_ENABLED === 'true' && !!process.env.CRON_SECRET })
  } catch (e) {
    console.error('[/api/campaigns GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'create')
  if (!auth.ok) return auth.response
  const session = auth.user

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(CreateCampaignSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'campaigns')

  const { name, message, messages, media_url, media_type, list_id, prospect_list_id, scheduled_at,
          antiblock_delay_min, antiblock_delay_max, type: campaignType,
          personalize_name,
          delay_type, custom_delay_seconds, daily_limit_override,
          anti_ban_profile_id, enable_mini_sessions, mini_session_text,
          message_type, template_id, template_params } = parsed.data
  const messageType = message_type ?? (template_id ? 'template' : 'text')
  if (messageType === 'template' && !template_id) return NextResponse.json({ error: 'Seleccioná una plantilla aprobada' }, { status: 400 })
  if (messageType === 'text' && (template_id || template_params)) return NextResponse.json({ error: 'Una campaña de texto no admite parámetros de plantilla' }, { status: 400 })
  let schedule: string | null
  try { schedule = normalizeCampaignSchedule(scheduled_at) } catch {
    return NextResponse.json({ error: 'Fecha de programación inválida' }, { status: 400 })
  }
  if (schedule) {
    if (!!list_id === !!prospect_list_id) return NextResponse.json({ error: 'Seleccioná una única lista antes de programar' }, { status: 400 })
    if (process.env.CAMPAIGN_SCHEDULER_ENABLED !== 'true' || !process.env.CRON_SECRET) return NextResponse.json({ error: 'La programación automática no está habilitada; guardá un borrador' }, { status: 409 })
    if (Date.parse(schedule) <= Date.now()) return NextResponse.json({ error: 'La fecha programada debe estar en el futuro' }, { status: 400 })
    const sendAuth = await checkPermissionWithUser(req, 'send', 'send')
    if (!sendAuth.ok) return sendAuth.response
  }

  // list_id y prospect_list_id son mutuamente excluyentes
  if (list_id && prospect_list_id) {
    return NextResponse.json(
      { error: 'No se puede usar list_id y prospect_list_id al mismo tiempo' },
      { status: 400 }
    )
  }

  // messages[] takes priority; fall back to single message
  const rawMsgs = messageType === 'template' ? ['[plantilla]'] : Array.isArray(messages) ? messages : (message ? [message] : [])
  if (rawMsgs.length === 0)
    return NextResponse.json({ error: 'Se requiere al menos un mensaje' }, { status: 400 })
  const msgArray = rawMsgs.map(m => m.trim()).filter(m => m.length > 0)
  if (msgArray.length === 0)
    return NextResponse.json({ error: 'Al menos un mensaje debe ser no vacío' }, { status: 400 })

  const delayMin = antiblock_delay_min ?? 3
  const delayMax = antiblock_delay_max ?? 8
  if (delayMin > delayMax)
    return NextResponse.json({ error: 'antiblock_delay_min no puede ser mayor que antiblock_delay_max' }, { status: 400 })

  // These historical options belonged to the retired external workflow. The
  // current processors enforce line limits and antiblock_delay_min/max instead.
  if (anti_ban_profile_id || enable_mini_sessions || daily_limit_override != null ||
      (delay_type && delay_type !== 'gaussian') ||
      (custom_delay_seconds !== undefined && custom_delay_seconds !== 18) ||
      (mini_session_text !== undefined && mini_session_text !== '👍')) {
    return NextResponse.json({ error: 'Estas opciones no están disponibles para campañas. Configurá las pausas mínima y máxima y los límites de cada línea.' }, { status: 400 })
  }

  const resolvedType = campaignType ?? 'promotion'
  const nameStr = name

  try {
    if (messageType === 'template') {
      const [template] = await query<{ name: string; status: string; waba_id: string | null; components: unknown }>(
        'SELECT name, status, waba_id, components FROM whatsapp_templates WHERE id=$1', [template_id])
      if (!template) return NextResponse.json({ error: 'Plantilla no encontrada' }, { status: 404 })
      if (template.status !== 'APROBADA' || !template.waba_id) return NextResponse.json({ error: 'La plantilla debe estar aprobada y sincronizada con una cuenta de WhatsApp' }, { status: 400 })
      const access = await getAccessibleLineIds(session)
      const available = await query(`SELECT cn.id FROM cloud_numbers cn WHERE cn.waba_id=$1 AND cn.status='active'
        AND ($2::uuid[] IS NULL OR cn.whatsapp_line_id=ANY($2::uuid[])) LIMIT 1`, [template.waba_id, access])
      if (!available.length) return NextResponse.json({ error: 'No tenés acceso a una línea de la cuenta de esta plantilla' }, { status: 403 })
      const error = validateCampaignTemplate(template.components, template_params ?? {})
      if (error) return NextResponse.json({ error }, { status: 400 })
      msgArray[0] = `[plantilla:${template.name}]`
    }
    // List ownership check — must run before inserting the campaign.
    // Non-admin can only create campaigns against lists they own.
    // Historical lists (owned_by IS NULL) are admin-only.
    if (list_id) {
      const [list] = await query<{ owned_by: string | null }>(
        'SELECT owned_by FROM contact_lists WHERE id = $1', [list_id]
      )
      if (!list)
        return NextResponse.json({ error: 'List not found' }, { status: 404 })
      if (!isOwnerOrAdmin(session, list.owned_by))
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (prospect_list_id) {
      const [pl] = await query<{ id: string; owned_by: string | null }>(
        'SELECT id, owned_by FROM prospect_lists WHERE id = $1', [prospect_list_id]
      )
      if (!pl)
        return NextResponse.json({ error: 'Prospect list not found' }, { status: 404 })
      if (!isOwnerOrAdmin(session, pl.owned_by)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    let total_targets = 0
    if (list_id) {
      const [r] = await query<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM contact_list_members clm JOIN contacts c ON c.id=clm.contact_id
         WHERE clm.list_id=$1 AND c.status='active' AND c.opt_in_marketing=true AND c.do_not_contact=false
         AND NOT EXISTS (SELECT 1 FROM blacklist bl WHERE bl.removed_at IS NULL AND bl.phone_number_normalized=regexp_replace(c.phone_number,'[^0-9]','','g'))`, [list_id]
      )
      total_targets = Number(r?.count || 0)
    } else if (prospect_list_id) {
      const [r] = await query<{ count: string }>(
        `SELECT COUNT(*)::int AS count
         FROM prospect_list_members plm
         JOIN prospects p ON p.id = plm.prospect_id
         WHERE plm.prospect_list_id = $1
           AND p.status = 'active' AND p.opt_in = true AND p.stage IS DISTINCT FROM 'descartado'
           AND NOT EXISTS (SELECT 1 FROM blacklist bl WHERE bl.removed_at IS NULL AND bl.phone_number_normalized=regexp_replace(p.phone_number,'[^0-9]','','g'))`,
        [prospect_list_id]
      )
      total_targets = Number(r?.count || 0)
    }

    const [campaign] = await query<{ id: string }>(
      `INSERT INTO campaigns
         (name, message, messages, media_url, media_type, list_id, prospect_list_id,
          type, status, scheduled_at,
          total_targets, antiblock_delay_min, antiblock_delay_max, personalize_name,
          use_multi_line,
          owned_by, updated_by, message_type, template_id, template_params)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$17,$18,$19::jsonb)
       RETURNING id`,
      [nameStr, msgArray[0], JSON.stringify(msgArray), media_url || null, media_type || null,
       list_id || null, prospect_list_id || null,
       resolvedType,
       schedule ? 'scheduled' : 'draft',
       schedule, total_targets,
       delayMin, delayMax,
       personalize_name !== false,
       true,
       session.user_id, messageType, template_id ?? null, template_params ? JSON.stringify(template_params) : null]
    )

    void audit({ req, action: 'create', resource: 'campaigns', resource_id: campaign.id,
      metadata: { name: nameStr } })
    return NextResponse.json({ id: campaign.id, name: nameStr, status: schedule ? 'scheduled' : 'draft' })
  } catch (e) {
    console.error('[/api/campaigns POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
