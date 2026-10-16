import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'
import { contactFilters } from '@/lib/contact-filters'
import { CONTACT_CASINO_STATS_SQL } from '@/lib/contact-casino-stats'
import { withContactMovementRead } from '@/lib/contact-movement-read'
import { ContactReadUnavailableError } from '@/lib/contact-read'
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
    const rows = await withContactMovementRead(async client => (await client.query<{
      platform: string | null; monto_cargas_mes: string; monto_retiros_mes: string
      last_deposit_at: string | null; mes_referencia: string | null; fuente: 'transactions' | 'historico'
    }>(CONTACT_CASINO_STATS_SQL, [id, AGENTS])).rows)
    const platforms = rows.map(r => ({ ...r, monto_cargas_mes: Number(r.monto_cargas_mes ?? 0), monto_retiros_mes: Number(r.monto_retiros_mes ?? 0) }))
    // Retain the old shape for consumers while the contact view renders every platform.
    const primary = platforms.find(p => p.platform === 'zeus') ?? platforms[0]
    return NextResponse.json({
      ...(primary ?? { monto_cargas_mes: 0, monto_retiros_mes: 0, last_deposit_at: null, mes_referencia: null, fuente: null }),
      bet30: primary?.platform === 'zeus' ? platforms.find(p => p.platform === 'bet30') ?? null : null,
      platforms,
    })
  } catch (e) {
    if (e instanceof ContactReadUnavailableError) return NextResponse.json({ error: e.message }, { status: 503, headers: { 'Retry-After': '3' } })
    console.error('[/api/contacts/[id]/casino-stats]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'No se pudo consultar el historial' }, { status: 500 })
  }
}
