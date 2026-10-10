import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { getAccessibleLineIds } from '@/lib/line-visibility'
import { scopedConversationMessages } from '@/lib/conversation-messages'
import { CONVERSATION_MEDIA_JOIN, conversationMediaUrl, type ConversationMediaRow } from '@/lib/conversation-media'
import { conversationInboxCte } from '@/lib/conversation-inbox'
import { LEVEL_DEFS, type CampaignOption } from '@/lib/scoring/conversation-scoring'

// Normaliza teléfono: quita + y espacios para comparar consistentemente
const normalize = (p: string) => p.replace(/^\+/, '').replace(/\s/g, '')

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'conversations', 'read')
  if (!auth.ok) return auth.response

  const phoneRaw = req.nextUrl.searchParams.get('phone')

  try {
    const lineIds = await getAccessibleLineIds(auth.user)
    if (phoneRaw) {
      const phone = normalize(phoneRaw)
      const scope = scopedConversationMessages(auth.user, 2)
      const messages = await query<ConversationMediaRow & {id:string;phone_number:string;message_body:string;direction:string;status:string;created_at:string;evolution_message_id:string;metadata:Record<string,unknown>}> (`
        ${scope.sql}
        SELECT recent.*, COALESCE(to_jsonb(wm)->'metadata','{}'::jsonb) AS metadata,
          media.media_type,media.media_id,media.media_caption FROM (
          SELECT id,phone_number,message_body,direction,status,created_at,evolution_message_id
          FROM conversation_messages WHERE REPLACE(phone_number,'+','')=$2
          ORDER BY created_at DESC,id DESC LIMIT 200
        ) recent LEFT JOIN whatsapp_messages wm ON wm.id=recent.id
        ${CONVERSATION_MEDIA_JOIN} ORDER BY recent.created_at ASC,recent.id ASC
      `, [lineIds,phone, ...scope.params])
      return NextResponse.json({ messages:messages.map(({metadata,media_id,media_type,...m})=>({
        ...m,media_type:media_type ?? metadata?.media_type,
        media_url:conversationMediaUrl(m.id,media_id),sticker_preview:metadata?.sticker_preview,
      })) })
    }

    const offsetRaw = req.nextUrl.searchParams.get('offset')
    const offset    = Math.max(0, parseInt(offsetRaw || '0', 10) || 0)
    const PAGE_SIZE = 200
    const campaign = req.nextUrl.searchParams.get('campaign') || 'all'
    const level = req.nextUrl.searchParams.get('level') || 'all'
    if (!['all', 'none'].includes(campaign) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(campaign)) {
      return NextResponse.json({ error: 'Campaña inválida' }, { status: 400 })
    }
    if (!['all', 'none', ...LEVEL_DEFS.map(item => item.key)].includes(level)) {
      return NextResponse.json({ error: 'Nivel inválido' }, { status: 400 })
    }
    const agent = (req.nextUrl.searchParams.get('agent') || 'all').trim().toLowerCase()
    if (agent.length > 100) return NextResponse.json({error:'Agente inválido'}, {status:400})
    const scope = scopedConversationMessages(auth.user, 6)
    const params = [lineIds, campaign.toLowerCase(), level]

    // Count, campaign options and page share one snapshot and one inbox scan.
    // Filter before pagination, then enrich only the requested page.
    const [{ total, campaigns, agents, conversations }] = await query<{
      total: string; campaigns: CampaignOption[]; agents: {name:string;count:number}[]; conversations: Record<string, unknown>[]
    }>(`
      ${conversationInboxCte(scope.sql, 6)}, enriched_page AS (
      SELECT page.*,
          assignment.ambiguous AS line_assignment_ambiguous,
          CASE WHEN NOT assignment.ambiguous AND directory.id IS NOT NULL
            THEN jsonb_build_object('label',directory.label,'phone',directory.phone)
            ELSE NULL END AS assigned_line,
          COALESCE(cs.is_escalated, false)         AS is_escalated,
          cs.escalation_reason,
          cs.current_flow                          AS conv_flow,
          EXISTS (
            SELECT 1 FROM blacklist bl
            WHERE bl.phone_number_normalized = page.phone_number
            AND   bl.removed_at IS NULL
          )                                        AS is_blacklisted,
          EXISTS (
            SELECT 1 FROM conversation_notes cn
            WHERE cn.phone = page.phone_number
            AND   cn.content LIKE '%Seguimiento programado%'
          )                                        AS has_follow_up,
          (SELECT REPLACE(tag, 'casino:actividad:', '')
           FROM contact_tags
           WHERE contact_id = page.contact_id AND tag LIKE 'casino:actividad:%'
           LIMIT 1)                                AS actividad,
          (SELECT REPLACE(tag, 'casino:valor_riesgo:', '')
           FROM contact_tags
           WHERE contact_id = page.contact_id AND tag LIKE 'casino:valor_riesgo:%'
           LIMIT 1)                                AS valor_riesgo
        FROM (SELECT * FROM filtered_inbox ORDER BY last_at DESC, phone_number LIMIT $4 OFFSET $5) page
        LEFT JOIN LATERAL (
          SELECT EXISTS (SELECT 1 FROM contacts other
            WHERE other.phone_number IN (page.phone_number,'+' || page.phone_number)
              AND other.deleted_at IS NULL AND other.id <> page.contact_id
              AND (NULLIF(lower(trim(other.panel)),''),other.linea,COALESCE(trim(other.linea_sub),''))
                IS DISTINCT FROM (page.agent,page.linea,COALESCE(trim(page.linea_sub),''))) AS ambiguous
        ) assignment ON true
        LEFT JOIN agent_contact_lines directory ON directory.agent_code=page.agent
          AND directory.linea=page.linea AND directory.variant=COALESCE(trim(page.linea_sub),'')
          AND directory.is_active=true
        LEFT JOIN LATERAL (
          SELECT is_escalated, escalation_reason, current_flow FROM conversation_state
          WHERE phone_number = page.phone_number AND resolved_at IS NULL LIMIT 1
        ) cs ON true
      )
      SELECT (SELECT COUNT(*)::text FROM filtered_inbox) AS total,
        COALESCE((SELECT jsonb_agg(options ORDER BY options.name, options.id) FROM (
          SELECT id, name, COUNT(*)::int AS count FROM campaign_threads GROUP BY id, name
        ) options), '[]'::jsonb) AS campaigns,
        COALESCE((SELECT jsonb_agg(options ORDER BY options.name) FROM (SELECT agent AS name, COUNT(*)::int AS count FROM inbox WHERE agent IS NOT NULL GROUP BY agent) options), '[]'::jsonb) AS agents,
        COALESCE((SELECT jsonb_agg(p ORDER BY p.last_at DESC, p.phone_number)
          FROM enriched_page p), '[]'::jsonb) AS conversations
    `, [...params, PAGE_SIZE, offset, agent, ...scope.params])
    const totalCount = parseInt(total, 10)

    return NextResponse.json({
      conversations: conversations.map(row => ({ ...row,
        last_at: row.last_at == null ? null : new Date(String(row.last_at)).toISOString(),
      })),
      campaigns, agents,
      total:    totalCount,
      has_more: offset + PAGE_SIZE < totalCount,
    })
  } catch (e) {
    console.error('[/api/conversations GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
