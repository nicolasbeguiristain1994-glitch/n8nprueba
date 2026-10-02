import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'
import { contactFilters } from '@/lib/contact-filters'
import { AGENTS } from '@/lib/casino-segmentation'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'read')
  if (!auth.ok) return auth.response
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  try {
    const scope = contactFilters(new URLSearchParams(), auth.user)
    const visible = await query(`SELECT id FROM contacts WHERE ${scope.sql} AND id=$${scope.params.length + 1}::uuid`, [...scope.params, id])
    if (!visible.length) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    // Same explicit/unique identities as the segmentation job. Never infer the
    // platform from a name suffix or mix namesakes from different platforms.
    const rows = await query<{
      platform: string | null; monto_cargas_mes: string; monto_retiros_mes: string
      last_deposit_at: string | null; mes_referencia: string | null; fuente: 'transactions' | 'historico'
    }>(`
      WITH accounts AS MATERIALIZED (
        SELECT p.*, GREATEST(p.fecha_ultima, cp.fecha_ultima) AS known_last
        FROM casino_contact_account_links l JOIN casino_segmentation_players p ON p.id=l.player_id
        LEFT JOIN casino_players cp ON cp.username_lower=p.username_lower
          AND cp.platform IS NOT DISTINCT FROM p.platform
        WHERE l.contact_id=$1 AND lower(trim(p.agente))=ANY($2::text[])
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
      ORDER BY h.platform NULLS LAST`, [id, AGENTS])
    const platforms = rows.map(r => ({ ...r, monto_cargas_mes: Number(r.monto_cargas_mes ?? 0), monto_retiros_mes: Number(r.monto_retiros_mes ?? 0) }))
    // Retain the old shape for consumers while the contact view renders every platform.
    const primary = platforms.find(p => p.platform === 'zeus') ?? platforms[0]
    return NextResponse.json({
      ...(primary ?? { monto_cargas_mes: 0, monto_retiros_mes: 0, last_deposit_at: null, mes_referencia: null, fuente: null }),
      bet30: primary?.platform === 'zeus' ? platforms.find(p => p.platform === 'bet30') ?? null : null,
      platforms,
    })
  } catch (e) {
    console.error('[/api/contacts/[id]/casino-stats]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'No se pudo consultar el historial' }, { status: 500 })
  }
}
