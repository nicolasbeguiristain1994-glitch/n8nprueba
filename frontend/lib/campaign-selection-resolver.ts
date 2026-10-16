import { NextResponse } from 'next/server'
import { query } from './db'
import { contactScope, type ContactAccessUser } from './contact-visibility'
import type { CampaignSelectionSummary } from './campaign-selection'

// One scoped scan supplies both the preview and the frozen campaign audience.
// Choosing one contact per normalized phone prevents duplicate recipients even
// if multiple selected records refer to the same WhatsApp number.
export async function resolveCampaignSelection(ids: string[], user: ContactAccessUser, run: typeof query = query) {
  const selected = [...new Set(ids)]
  const scope = contactScope(user, 1, 'c')
  const [row] = await run<{ matched: number; eligible_ids: string[]; blacklisted: number; inactive: number; opted_out: number; eligible_rows: number }>(`
    WITH selected_contacts AS MATERIALIZED (
      SELECT c.id, regexp_replace(c.phone_number,'[^0-9]','','g') AS phone,
        CASE
          WHEN EXISTS (SELECT 1 FROM blacklist bl WHERE bl.removed_at IS NULL
            AND bl.phone_number_normalized=regexp_replace(c.phone_number,'[^0-9]','','g')
            AND (bl.scope_key='global' OR bl.agent_code=contact_agent_key(c.panel))) THEN 'blacklisted'
          WHEN c.status IS DISTINCT FROM 'active' THEN 'inactive'
          WHEN c.opt_in_marketing IS DISTINCT FROM true OR c.do_not_contact IS DISTINCT FROM false THEN 'opted_out'
          ELSE 'eligible'
        END AS eligibility
      FROM contacts c WHERE c.id=ANY($1::uuid[]) AND ${scope.sql}
    ), eligible AS (
      SELECT DISTINCT ON (phone) id, phone FROM selected_contacts
      WHERE eligibility='eligible' ORDER BY phone, id
    )
    SELECT COUNT(*)::int AS matched,
      COUNT(*) FILTER (WHERE eligibility='blacklisted')::int AS blacklisted,
      COUNT(*) FILTER (WHERE eligibility='inactive')::int AS inactive,
      COUNT(*) FILTER (WHERE eligibility='opted_out')::int AS opted_out,
      COUNT(*) FILTER (WHERE eligibility='eligible')::int AS eligible_rows,
      ARRAY(SELECT id FROM eligible ORDER BY id) AS eligible_ids
    FROM selected_contacts
  `, [selected, ...scope.params])
  if (!row || Number(row.matched) !== selected.length) throw NextResponse.json({
    error: 'La selección incluye contactos eliminados o fuera de tu alcance. Volvé a seleccionarlos desde Contactos.',
  }, { status: 403 })
  const eligibleIds = row.eligible_ids
  const summary: CampaignSelectionSummary = {
    selected: selected.length, eligible: eligibleIds.length, excluded: selected.length - eligibleIds.length,
    blacklisted: Number(row.blacklisted), inactive: Number(row.inactive), opted_out: Number(row.opted_out),
    duplicates: Number(row.eligible_rows) - eligibleIds.length,
  }
  return { summary, eligibleIds }
}
