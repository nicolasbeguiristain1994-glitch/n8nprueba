import { query } from '@/lib/db'
import type { SessionUser } from '@/lib/auth'
import { getAccessibleLineIds } from '@/lib/line-visibility'

export type TemplateAccount = { waba_id: string; name: string; line_count: number; connected: boolean }

// Account labels come from connected business numbers, never from credentials.
export async function listTemplateAccounts(user: SessionUser): Promise<TemplateAccount[]> {
  const ids = await getAccessibleLineIds(user)
  return query<TemplateAccount>(`WITH visible AS (
    SELECT cn.waba_id, cn.status, cn.verified_name, wl.display_name AS line_name
    FROM cloud_numbers cn LEFT JOIN whatsapp_lines wl ON wl.id=cn.whatsapp_line_id
    WHERE ($1::uuid[] IS NULL OR cn.whatsapp_line_id=ANY($1::uuid[]))
  ), accounts AS (
    SELECT waba_id FROM visible
    UNION SELECT waba_id FROM whatsapp_templates WHERE waba_id IS NOT NULL AND $1::uuid[] IS NULL
  ) SELECT a.waba_id,
      COALESCE(MIN(NULLIF(v.verified_name,'')), MIN(NULLIF(v.line_name,'')), 'Cuenta ' || a.waba_id) AS name,
      COUNT(v.waba_id)::int AS line_count, COALESCE(BOOL_OR(v.status='active'),false) AS connected
    FROM accounts a LEFT JOIN visible v ON v.waba_id=a.waba_id
    GROUP BY a.waba_id ORDER BY name,a.waba_id`, [ids])
}

export async function templateAccountNumber(user: SessionUser, wabaId: string): Promise<string | null> {
  const ids = await getAccessibleLineIds(user)
  const [row] = await query<{ phone_number_id: string }>(`SELECT phone_number_id FROM cloud_numbers
    WHERE waba_id=$1 AND status='active'
      AND ($2::uuid[] IS NULL OR whatsapp_line_id=ANY($2::uuid[]))
    ORDER BY token_expires_at DESC NULLS FIRST, phone_number_id LIMIT 1`, [wabaId, ids])
  return row?.phone_number_id ?? null
}
