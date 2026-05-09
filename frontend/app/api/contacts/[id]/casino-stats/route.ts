import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermission } from '@/lib/permissions'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const err = await checkPermission(req, 'contacts', 'read')
  if (err) return err

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  try {
    // Obtener el username del contacto (first_name) para unir con casino_transactions
    const [contact] = await query<{ first_name: string | null }>(
      'SELECT first_name FROM contacts WHERE id = $1', [id]
    )
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

    const username = contact.first_name?.trim().toLowerCase()
    if (!username) {
      return NextResponse.json({ monto_cargas_mes: 0, monto_retiros_mes: 0, last_deposit_at: null })
    }

    const [stats] = await query<{
      monto_cargas_mes: number
      monto_retiros_mes: number
      last_deposit_at: string | null
    }>(`
      SELECT
        COALESCE(SUM(CASE WHEN tipo = 'carga'  AND fecha >= NOW() - INTERVAL '30 days' THEN monto ELSE 0 END), 0)::int AS monto_cargas_mes,
        COALESCE(SUM(CASE WHEN tipo = 'retiro' AND fecha >= NOW() - INTERVAL '30 days' THEN ABS(monto) ELSE 0 END), 0)::int AS monto_retiros_mes,
        MAX(CASE WHEN tipo = 'carga' THEN fecha END) AS last_deposit_at
      FROM casino_transactions
      WHERE LOWER(username) = $1
    `, [username])

    return NextResponse.json(stats ?? { monto_cargas_mes: 0, monto_retiros_mes: 0, last_deposit_at: null })
  } catch (e) {
    console.error('[/api/contacts/[id]/casino-stats]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
