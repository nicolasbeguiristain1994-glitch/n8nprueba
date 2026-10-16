import { contactAccountLinksSql } from './campaign-contact-accounts'

// Resolve and aggregate only this contact's candidate usernames. Keep every
// platform for those names so unrelated accounts cannot hide ambiguity.
export const CONTACT_CASINO_STATS_SQL = `
      WITH recipients AS (SELECT $1::uuid AS contact_id),
      linked AS MATERIALIZED (${contactAccountLinksSql(false, true)}),
      accounts AS MATERIALIZED (
        SELECT p.*, GREATEST(p.fecha_ultima, cp.fecha_ultima) AS known_last
        FROM linked p LEFT JOIN casino_players cp ON cp.username_lower=p.username_lower
          AND cp.platform IS NOT DISTINCT FROM p.platform
        WHERE lower(trim(p.agente))=ANY($2::text[])
      ), tx AS MATERIALIZED (
        SELECT a.platform,ct.fecha,ct.tipo,ct.monto FROM accounts a
        JOIN casino_transactions ct ON lower(ct.username)=a.username_lower
          AND ct.platform IS NOT DISTINCT FROM a.platform
        WHERE ct.fecha<=CURRENT_DATE
      ), months AS (
        SELECT platform,date_trunc('month',MAX(fecha)) AS month FROM tx GROUP BY platform
      ), history AS (
        SELECT platform,SUM(total_cargas) AS amount,SUM(total_retiros) AS withdrawals,
          MAX(known_last) AS last_date FROM accounts GROUP BY platform
      )
      SELECT h.platform,
        CASE WHEN m.month IS NULL THEN h.amount ELSE
          COALESCE(SUM(t.monto) FILTER (WHERE t.tipo='carga' AND date_trunc('month',t.fecha)=m.month),0) END AS monto_cargas_mes,
        CASE WHEN m.month IS NULL THEN h.withdrawals ELSE
          COALESCE(SUM(ABS(t.monto)) FILTER (WHERE t.tipo='retiro' AND date_trunc('month',t.fecha)=m.month),0) END AS monto_retiros_mes,
        GREATEST(h.last_date,MAX(t.fecha) FILTER (WHERE t.tipo='carga')) AS last_deposit_at,
        to_char(m.month,'MM/YYYY') AS mes_referencia,
        CASE WHEN m.month IS NULL THEN 'historico' ELSE 'transactions' END AS fuente
      FROM history h LEFT JOIN months m ON m.platform IS NOT DISTINCT FROM h.platform
      LEFT JOIN tx t ON t.platform IS NOT DISTINCT FROM h.platform
      GROUP BY h.platform,h.amount,h.withdrawals,h.last_date,m.month
      ORDER BY h.platform NULLS LAST`
