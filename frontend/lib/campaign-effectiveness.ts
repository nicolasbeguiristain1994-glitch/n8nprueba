import { query } from '@/lib/db'
import { CAMPAIGN_OUTCOME_SQL } from './campaign-stats'
import { CAMPAIGN_CONTACT_ACCOUNTS_SQL } from './campaign-contact-accounts'

export interface EffectiveRecipient {
  recipient_id: string
  contact_id: string
  phone_number: string
  cuentas_carga: { usuario: string; plataforma: string }[]
  sent_at: string
  primera_carga: string
  cargas: number
  monto_cargado: string
}

export interface CampaignEffectiveness {
  campaign_id: string
  efectivos: number
  tasa_efectividad: string | null
  cargas_24h: number
  monto_cargado_24h: string
  monto_apostado_24h: null
  ventanas_abiertas: number
  sin_cuenta: number
  sin_hora_envio: number
  cargas_sin_hora: number
  efectivos_detalle: EffectiveRecipient[]
}

// Run once for the authorized campaign IDs, after list pagination/ownership.
// Each campaign has its own (actual send, send + 24 hours] window per recipient.
// Never substitute campaign creation, a calendar date, or an account's lifetime
// totals for exact timestamps. Account matching preserves platform/name
// ambiguity. A transaction is summed once per campaign, even for shared accounts.
export const CAMPAIGN_EFFECTIVENESS_SQL = `
  WITH latest_messages AS (
    SELECT DISTINCT ON (wm.campaign_id,regexp_replace(wm.phone_number,'[^0-9]','','g'))
      wm.campaign_id,regexp_replace(wm.phone_number,'[^0-9]','','g') AS phone,
      wm.status,wm.sent_at,wm.created_at
    FROM whatsapp_messages wm
    WHERE wm.campaign_id=ANY($1::uuid[]) AND wm.direction='outbound'
    ORDER BY wm.campaign_id,regexp_replace(wm.phone_number,'[^0-9]','','g'),wm.created_at DESC,wm.id DESC
  ), recipients AS MATERIALIZED (
    SELECT cr.id AS recipient_id,cr.campaign_id,cr.contact_id,cr.phone_number,
      CASE WHEN m.status IN ('sent','delivered','read')
        THEN COALESCE(m.sent_at,cr.sent_at,m.created_at) ELSE cr.sent_at END AS sent_at
    FROM campaign_recipients cr LEFT JOIN latest_messages m
      ON m.campaign_id=cr.campaign_id AND m.phone=regexp_replace(cr.phone_number,'[^0-9]','','g')
    WHERE cr.campaign_id=ANY($1::uuid[])
      AND ${CAMPAIGN_OUTCOME_SQL} IN ('sent','delivered','read')
  ), accounts AS MATERIALIZED (
    ${CAMPAIGN_CONTACT_ACCOUNTS_SQL}
  ), deposits AS MATERIALIZED (
    SELECT DISTINCT r.campaign_id,r.recipient_id,t.id,t.fecha_hora_utc,
      COALESCE(s.monto,t.monto) AS monto,a.username_lower AS username,a.platform
    FROM recipients r JOIN accounts a ON a.contact_id=r.contact_id
    JOIN casino_transactions t ON t.platform=a.platform AND lower(t.username)=a.username_lower
    LEFT JOIN casino_financial_source_records s
      ON s.transaction_id=t.id AND s.platform=t.platform AND s.kind='importe_original'
    WHERE t.tipo='carga' AND t.monto>0 AND r.sent_at IS NOT NULL
      AND NOT (t.platform IN ('zeus','bet30') AND lower(trim(COALESCE(t.raw_detalles,'')))='bono')
      AND (
        (t.fecha_hora_utc>r.sent_at AND t.fecha_hora_utc<=r.sent_at+interval '24 hours')
        OR (t.fecha_hora_utc IS NULL AND t.fecha BETWEEN
          (r.sent_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AND
          ((r.sent_at+interval '24 hours') AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)
      )
  ), recipient_totals AS (
    SELECT r.*,EXISTS(SELECT 1 FROM accounts a WHERE a.contact_id=r.contact_id) AS linked,
      d.cargas,d.monto_cargado,d.primera_carga,d.cuentas_carga
    FROM recipients r LEFT JOIN (
      SELECT recipient_id,COUNT(*)::int AS cargas,SUM(monto)::text AS monto_cargado,
        MIN(fecha_hora_utc) AS primera_carga,
        jsonb_agg(DISTINCT jsonb_build_object('usuario',username,'plataforma',platform)
          ORDER BY jsonb_build_object('usuario',username,'plataforma',platform)) AS cuentas_carga
      FROM deposits WHERE fecha_hora_utc IS NOT NULL GROUP BY recipient_id
    ) d USING (recipient_id)
  )
  SELECT requested.campaign_id,
    COUNT(r.recipient_id) FILTER (WHERE r.cargas>0)::int AS efectivos,
    ROUND(100.0*COUNT(r.recipient_id) FILTER (WHERE r.cargas>0)/NULLIF(COUNT(r.recipient_id),0),1)::text AS tasa_efectividad,
    (SELECT COUNT(DISTINCT id)::int FROM deposits d WHERE d.campaign_id=requested.campaign_id AND d.fecha_hora_utc IS NOT NULL) AS cargas_24h,
    (SELECT COALESCE(SUM(monto),0)::text FROM (
      SELECT DISTINCT id,monto FROM deposits d WHERE d.campaign_id=requested.campaign_id AND d.fecha_hora_utc IS NOT NULL
    ) unique_deposits) AS monto_cargado_24h,
    NULL::text AS monto_apostado_24h,
    COUNT(r.recipient_id) FILTER (WHERE r.sent_at+interval '24 hours'>CURRENT_TIMESTAMP)::int AS ventanas_abiertas,
    COUNT(r.recipient_id) FILTER (WHERE NOT r.linked)::int AS sin_cuenta,
    COUNT(r.recipient_id) FILTER (WHERE r.sent_at IS NULL)::int AS sin_hora_envio,
    (SELECT COUNT(DISTINCT id)::int FROM deposits d WHERE d.campaign_id=requested.campaign_id AND d.fecha_hora_utc IS NULL) AS cargas_sin_hora,
    CASE WHEN $2::boolean THEN COALESCE(jsonb_agg(jsonb_build_object(
      'recipient_id',r.recipient_id,'contact_id',r.contact_id,'phone_number',r.phone_number,
      'cuentas_carga',r.cuentas_carga,
      'sent_at',r.sent_at,'primera_carga',r.primera_carga,'cargas',r.cargas,'monto_cargado',r.monto_cargado
    ) ORDER BY r.primera_carga,r.recipient_id) FILTER (WHERE r.cargas>0),'[]'::jsonb) ELSE '[]'::jsonb END AS efectivos_detalle
  FROM unnest($1::uuid[]) requested(campaign_id)
  LEFT JOIN recipient_totals r ON r.campaign_id=requested.campaign_id
  GROUP BY requested.campaign_id`

export async function campaignEffectiveness(campaignIds: string[], includeRecipients = false) {
  if (!campaignIds.length) return new Map<string, CampaignEffectiveness>()
  const rows = await query<CampaignEffectiveness>(CAMPAIGN_EFFECTIVENESS_SQL, [campaignIds, includeRecipients])
  return new Map(rows.map(row => [row.campaign_id, row]))
}
