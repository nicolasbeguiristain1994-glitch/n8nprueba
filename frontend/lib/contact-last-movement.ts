import { CAMPAIGN_CONTACT_ACCOUNTS_SQL } from './campaign-contact-accounts'
import type { InactivityRange } from './inactivity-range'

export interface ContactMovementRow {
  contact_id: string
  last_movement: string | null
  days_inactive: number | null
}

/** Resolve identity globally, then take the latest carga/retiro across every
 * linked account. A platform audience filter must never hide recent activity. */
export function contactLastMovementQuery(audience: { sql: string; params: unknown[] }, range?: InactivityRange) {
  const params = [...audience.params]
  const bind = (value: unknown) => { params.push(value); return `$${params.length}` }
  const today = "(CURRENT_TIMESTAMP AT TIME ZONE 'America/Argentina/Buenos_Aires')::date"
  const bounds = [`last_movement <= ${today}`]
  if (range?.min) bounds.push(`last_movement < ${today} - ${bind(Number(range.min))}::int`)
  if (range?.max) bounds.push(`last_movement >= ${today} - ${bind(Number(range.max))}::int`)
  const filter = !range ? '' : range.mode === 'missing'
    ? 'WHERE last_movement IS NULL' : `WHERE ${bounds.join(' AND ')}`
  return { params, sql: `WITH recipients AS MATERIALIZED (
    SELECT contacts.id AS contact_id FROM contacts WHERE ${audience.sql}
  ), linked_accounts AS MATERIALIZED (
    ${CAMPAIGN_CONTACT_ACCOUNTS_SQL}
  ), movements AS (
    SELECT a.contact_id,max(t.fecha) AS last_movement
    FROM linked_accounts a JOIN casino_transactions t
      ON t.platform=a.platform AND lower(t.username)=a.username_lower
    WHERE t.tipo IN ('carga','retiro') AND t.platform IN ('zeus','bet30','ganamos','argenbet')
    GROUP BY a.contact_id
  ) SELECT r.contact_id,m.last_movement::text,${today}-m.last_movement AS days_inactive
    FROM recipients r LEFT JOIN movements m USING(contact_id) ${filter}` }
}
