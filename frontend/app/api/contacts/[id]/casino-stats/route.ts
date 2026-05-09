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
    // Buscar el username en casino_players usando el mismo join que el resto del sistema
    // (LOWER(TRIM(first_name)) = username_lower). Si el nombre está partido en
    // first_name + last_name probamos ambas combinaciones.
    const [contact] = await query<{ first_name: string | null; last_name: string | null }>(
      'SELECT first_name, last_name FROM contacts WHERE id = $1', [id]
    )
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

    // Intentar las combinaciones: solo first_name, solo last_name, first+last
    const candidates = [
      contact.first_name,
      contact.last_name,
      [contact.first_name, contact.last_name].filter(Boolean).join(' '),
    ]
      .filter(Boolean)
      .map(s => s!.trim().toLowerCase())
      .filter(s => s.length > 0)

    // Buscar en casino_players cuál de los candidatos tiene match
    const cpRows = await query<{ username: string }>(
      `SELECT username FROM casino_players WHERE username_lower = ANY($1::text[]) LIMIT 1`,
      [candidates]
    )

    const username = cpRows[0]?.username?.toLowerCase() ?? null

    if (!username) {
      return NextResponse.json({ monto_cargas_mes: 0, monto_retiros_mes: 0, last_deposit_at: null })
    }

    // Obtener el mes más reciente con actividad para este usuario,
    // luego sumar cargas y retiros de ese mes
    const [stats] = await query<{
      monto_cargas_mes: number
      monto_retiros_mes: number
      last_deposit_at: string | null
      mes_referencia: string | null
    }>(`
      WITH ultimo_mes AS (
        SELECT DATE_TRUNC('month', MAX(fecha)) AS mes
        FROM casino_transactions
        WHERE LOWER(username) = $1
      )
      SELECT
        COALESCE(SUM(CASE WHEN ct.tipo = 'carga'  AND DATE_TRUNC('month', ct.fecha) = um.mes THEN ct.monto       ELSE 0 END), 0)::int AS monto_cargas_mes,
        COALESCE(SUM(CASE WHEN ct.tipo = 'retiro' AND DATE_TRUNC('month', ct.fecha) = um.mes THEN ABS(ct.monto)  ELSE 0 END), 0)::int AS monto_retiros_mes,
        MAX(CASE WHEN ct.tipo = 'carga' THEN ct.fecha END)                                                                            AS last_deposit_at,
        TO_CHAR(um.mes, 'Mon YYYY')                                                                                                   AS mes_referencia
      FROM casino_transactions ct
      CROSS JOIN ultimo_mes um
      WHERE LOWER(ct.username) = $1
      GROUP BY um.mes
    `, [username])

    return NextResponse.json(stats ?? { monto_cargas_mes: 0, monto_retiros_mes: 0, last_deposit_at: null, mes_referencia: null })
  } catch (e) {
    console.error('[/api/contacts/[id]/casino-stats]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
