import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID, clampStr } from '@/lib/validate'
import { checkPermissionWithUser, isOwnerOrAdmin } from '@/lib/permissions'
import { audit } from '@/lib/audit'

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

    const campaignSql = (includePauseReason: boolean) => `
      SELECT c.id, c.name, c.message, c.messages, c.status, c.scheduled_at,
             c.started_at, c.completed_at,
             c.total_targets, c.personalize_name,
             c.antiblock_delay_min, c.antiblock_delay_max,
             c.use_multi_line,
             ${includePauseReason ? 'c.pause_reason,' : 'NULL::text AS pause_reason,'}
             c.processor_locked_at,
             c.created_at, c.owned_by, cl.name AS list_name, cl.id AS list_id,
             COALESCE(cr.sent, 0)::int                                             AS total_sent,
             COUNT(m.id) FILTER (WHERE m.status IN ('delivered','read'))::int      AS total_delivered,
             COUNT(m.id) FILTER (WHERE m.status = 'read')::int                    AS total_read,
             COALESCE(cr.failed, 0)::int                                           AS total_failed,
             COALESCE(cr.skipped, 0)::int                                          AS total_skipped,
             CASE WHEN COALESCE(cr.sent, 0) > 0
               THEN ROUND(COUNT(m.id) FILTER (WHERE m.status = 'read')::numeric /
                          COALESCE(cr.sent, 0) * 100, 1)
               ELSE 0 END AS read_rate,
             CASE WHEN c.total_targets > 0
               THEN ROUND(COALESCE(cr.sent, 0)::numeric / c.total_targets * 100, 1)
               ELSE 0 END AS delivery_rate
      FROM campaigns c
      LEFT JOIN contact_lists cl ON cl.id = c.list_id
      LEFT JOIN whatsapp_messages m ON m.campaign_id = c.id
      LEFT JOIN (
        SELECT campaign_id,
               COUNT(*) FILTER (WHERE status = 'sent')    AS sent,
               COUNT(*) FILTER (WHERE status = 'failed')  AS failed,
               COUNT(*) FILTER (WHERE status = 'skipped') AS skipped
        FROM campaign_recipients
        GROUP BY campaign_id
      ) cr ON cr.campaign_id = c.id
      ${ownerClause}
      GROUP BY c.id, cl.id, cr.sent, cr.failed, cr.skipped
      ORDER BY c.created_at DESC
    `

    let campaigns
    try {
      campaigns = await query(campaignSql(true), params)
    } catch (e) {
      // Fallback: migración 054 (pause_reason) no aplicada aún en producción
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('pause_reason') || msg.includes('column')) {
        console.warn('[/api/campaigns GET] pause_reason column missing — running without it. Apply migration 054.')
        campaigns = await query(campaignSql(false), params)
      } else {
        throw e
      }
    }

    return NextResponse.json({ campaigns })
  } catch (e) {
    console.error('[/api/campaigns GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'create')
  if (!auth.ok) return auth.response
  const session = auth.user

  let body: {
    name?: string; message?: string; messages?: string[]; media_url?: string; media_type?: string
    list_id?: string; scheduled_at?: string; antiblock_delay_min?: number; antiblock_delay_max?: number
    type?: string; personalize_name?: boolean; use_multi_line?: boolean
    delay_type?: string; custom_delay_seconds?: number; daily_limit_override?: number | null
    anti_ban_profile_id?: string | null; enable_mini_sessions?: boolean; mini_session_text?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { name, message, messages, media_url, media_type, list_id, scheduled_at,
          antiblock_delay_min, antiblock_delay_max, type: campaignType,
          personalize_name, use_multi_line,
          delay_type, custom_delay_seconds, daily_limit_override,
          anti_ban_profile_id, enable_mini_sessions, mini_session_text } = body

  const nameStr = clampStr(name, 255)
  if (!nameStr)
    return NextResponse.json({ error: 'El nombre de la campaña es requerido' }, { status: 400 })

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

  if (anti_ban_profile_id !== undefined && anti_ban_profile_id !== null && !isUUID(anti_ban_profile_id))
    return NextResponse.json({ error: 'anti_ban_profile_id debe ser un UUID válido' }, { status: 400 })

  const ALLOWED_DELAY_TYPES = ['gaussian', 'human_noisy', 'uniform']
  const resolvedDelayType = delay_type && ALLOWED_DELAY_TYPES.includes(delay_type) ? delay_type : 'gaussian'
  const resolvedCustomDelay = custom_delay_seconds !== undefined ? Math.max(5, Number(custom_delay_seconds)) : 18
  const resolvedDailyLimit = daily_limit_override != null ? Math.max(5, Number(daily_limit_override)) : null

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
          total_targets, antiblock_delay_min, antiblock_delay_max, personalize_name,
          use_multi_line, delay_type, custom_delay_seconds, daily_limit_override,
          anti_ban_profile_id, enable_mini_sessions, mini_session_text,
          owned_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)
       RETURNING id`,
      [nameStr, msgArray[0], JSON.stringify(msgArray), media_url || null, media_type || null,
       list_id || null, resolvedType,
       scheduled_at ? 'scheduled' : 'draft',
       scheduled_at || null, total_targets,
       delayMin, delayMax,
       personalize_name !== false,
       use_multi_line === true,
       resolvedDelayType, resolvedCustomDelay, resolvedDailyLimit,
       anti_ban_profile_id || null,
       enable_mini_sessions === true,
       mini_session_text || '👍',
       session.user_id]
    )

    void audit({ req, action: 'create', resource: 'campaigns', resource_id: campaign.id,
      metadata: { name: nameStr } })
    return NextResponse.json({ id: campaign.id, name: nameStr, status: scheduled_at ? 'scheduled' : 'draft' })
  } catch (e) {
    console.error('[/api/campaigns POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
