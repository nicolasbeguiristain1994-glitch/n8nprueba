import { query } from './db'
import { campaignRoutingHistorySQL } from './campaign-routing'
import { campaignLineEligibleExpr } from './line-eligibility'

export type RoutingPreviewLine = {
  id: string; name: string; phone: string | null; assigned: number; habitual: number; new: number
  remaining_hour: number; remaining_day: number; pending: number; reason: string | null
}
export type CampaignRoutingPreview = {
  calculated_at: string; eligible: number; excluded: number; assigned: number; unassigned: number
  pending: number; hidden_line_contacts: number; lines: RoutingPreviewLine[]; has_variable_schedule: boolean
}

type Line = {
  id: string; name: string; phone: string | null; line_type: string; waba_id: string | null
  eligible: boolean; status: string; is_connected: boolean; sending_enabled: boolean
  allowed_types: string[] | null; registered: boolean; remaining_hour: number; remaining_day: number
  personality_config: { activeHours?: number[]; timezoneOffsetHours?: number; aggressiveness?: number } | null
}

// Do not sample or mutate the dispatcher's random sleep decisions in a preview.
// Fixed windows can be evaluated; marginal-hour pauses remain estimates.
export function outsidePreviewWindow(line: Pick<Line, 'line_type' | 'personality_config'>, now: Date): boolean {
  const config = line.personality_config, hours = config?.activeHours
  if (line.line_type !== 'evolution' || !Array.isArray(hours) || hours.length !== 2
    || !hours.every(hour => Number.isFinite(hour) && hour >= 0 && hour < 24)
    || typeof config?.aggressiveness !== 'number' || !Number.isFinite(config.aggressiveness)) return false
  const offset = typeof config?.timezoneOffsetHours === 'number' ? config.timezoneOffsetHours : -3
  const hour = (now.getUTCHours() + now.getUTCMinutes() / 60 + offset + 24) % 24
  return hours[0] <= hours[1] ? hour < hours[0] || hour >= hours[1] : hour < hours[0] && hour >= hours[1]
}

/** Forecast the initial allocation, without reserving lines or consuming rotation/counters. */
export async function previewCampaignRouting(phones: string[], owner: string, waba: string | null, run: typeof query = query): Promise<CampaignRoutingPreview> {
  // Simulate the same expired-counter reset as getEligibleLines, using SELECT only.
  const lines = await run<Line>(`
    WITH wl AS (
      SELECT base.*, CASE WHEN hour_reset_at <= NOW() THEN 0 ELSE msgs_sent_hour END AS effective_hour,
        CASE WHEN day_reset_at <= NOW() THEN 0 ELSE msgs_sent_today END AS effective_day
      FROM whatsapp_lines base
      WHERE id IN (SELECT get_accessible_line_ids($1::uuid))
    )
    SELECT wl.id, COALESCE(NULLIF(wl.display_name,''),wl.line_key) AS name, wl.phone_number AS phone,
      wl.line_type, cn.waba_id, wl.status, wl.is_connected, wl.sending_enabled, wl.allowed_types,
      cn.id IS NOT NULL AS registered, wl.personality_config,
      GREATEST(0,wl.msg_per_hour-wl.effective_hour)::int AS remaining_hour,
      GREATEST(0,wl.msg_per_day-wl.effective_day)::int AS remaining_day,
      ${campaignLineEligibleExpr('wl').replaceAll('wl.msgs_sent_hour', 'wl.effective_hour').replaceAll('wl.msgs_sent_today', 'wl.effective_day')} AS eligible
    FROM wl LEFT JOIN cloud_numbers cn ON cn.whatsapp_line_id=wl.id AND cn.status='active'
    ORDER BY wl.id`, [owner])
  const now = new Date()
  const reason = (line: Line): string | null => {
    if (waba && (line.line_type !== 'cloud' || line.waba_id !== waba)) return 'No compatible con esta plantilla'
    if (line.status !== 'active' || !line.is_connected) return 'Desconectada o inactiva'
    if (!line.sending_enabled) return 'Envíos deshabilitados'
    if (line.allowed_types && !line.allowed_types.includes('campaign')) return 'No habilitada para campañas'
    if (line.line_type === 'cloud' && !line.registered) return 'Número Cloud no disponible'
    if (!line.remaining_day) return 'Sin cupo diario'
    if (!line.remaining_hour) return 'Sin cupo por hora'
    if (outsidePreviewWindow(line, now)) return 'Fuera de su horario'
    return line.eligible ? null : 'No disponible'
  }
  const lineReasons = new Map(lines.map(line => [line.id, reason(line)]))
  const eligibleIds = lines.filter(line => !lineReasons.get(line.id)).map(line => line.id).sort()
  const allocation = await run<{ line_id: string | null; assigned: number; habitual: number; fresh: number }>(`
    WITH destinations AS MATERIALIZED (SELECT DISTINCT regexp_replace(unnest($1::text[]),'[^0-9]','','g') AS phone),
    existing AS MATERIALIZED (
      SELECT d.phone,a.line_id FROM destinations d JOIN campaign_line_assignments a ON a.phone=d.phone
      WHERE a.owner_key=$2::uuid AND a.line_id IS NOT NULL
    ), missing AS MATERIALIZED (
      SELECT phone FROM destinations d WHERE NOT EXISTS(SELECT 1 FROM existing e WHERE e.phone=d.phone)
    ), ${campaignRoutingHistorySQL('$2::uuid', '$2::uuid')},
    recovered AS (SELECT DISTINCT ON (phone) phone,line_id FROM history ORDER BY phone,at DESC NULLS LAST,line_id),
    habitual AS (SELECT * FROM existing UNION ALL SELECT * FROM recovered),
    numbered AS (
      SELECT phone,ROW_NUMBER() OVER (ORDER BY phone)-1 AS n FROM missing m
      WHERE NOT EXISTS(SELECT 1 FROM recovered h WHERE h.phone=m.phone)
    ), allocated AS (
      SELECT line_id,true AS habitual FROM habitual
      UNION ALL
      SELECT CASE WHEN cardinality($3::uuid[])>0 THEN
        ($3::uuid[])[((COALESCE((SELECT next_position FROM campaign_line_rotation WHERE owner_key=$2::uuid),0)+n)
          % NULLIF(cardinality($3::uuid[]),0)+1)::int] ELSE NULL END,false FROM numbered
    )
    SELECT line_id,COUNT(*)::int AS assigned,COUNT(*) FILTER(WHERE habitual)::int AS habitual,
      COUNT(*) FILTER(WHERE NOT habitual)::int AS fresh FROM allocated GROUP BY line_id`, [phones, owner, eligibleIds])
  const counts = new Map(allocation.map(row => [row.line_id, row]))
  const visibleIds = new Set(lines.map(line => line.id))
  const hidden = allocation.filter(row => row.line_id && !visibleIds.has(row.line_id)).reduce((sum,row) => sum+row.assigned,0)
  const rows: RoutingPreviewLine[] = lines.filter(line => !lineReasons.get(line.id) || counts.has(line.id)).map(line => {
    const count = counts.get(line.id), assigned = count?.assigned ?? 0, blocked = lineReasons.get(line.id) ?? null
    return { id:line.id,name:line.name,phone:line.phone,assigned,habitual:count?.habitual ?? 0,new:count?.fresh ?? 0,
      remaining_hour:line.remaining_hour,remaining_day:line.remaining_day,reason:blocked,
      pending:blocked ? assigned : Math.max(0,assigned-Math.min(line.remaining_hour,line.remaining_day)) }
  }).sort((a,b) => b.assigned-a.assigned || a.name.localeCompare(b.name))
  const unassigned = counts.get(null)?.assigned ?? 0
  const total = allocation.reduce((sum,row) => sum+row.assigned,0)
  return { calculated_at:now.toISOString(),eligible:total,excluded:0,assigned:total-unassigned,unassigned,
    pending:unassigned+hidden+rows.reduce((sum,line) => sum+line.pending,0),hidden_line_contacts:hidden,lines:rows,
    has_variable_schedule:lines.some(line => line.line_type==='evolution' && !!line.personality_config) }
}
