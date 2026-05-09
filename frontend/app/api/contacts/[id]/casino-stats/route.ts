import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermission } from '@/lib/permissions'

// Strips platform prefixes like "Z/ ", "ZS/ ", "Zeus/ " from stored first_name
// so the raw casino username can be matched against casino_players.username_lower
function extractUsername(s: string): string {
  return s.replace(/^[a-zA-Z]+\/\s*/, '').trim().toLowerCase()
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const err = await checkPermission(req, 'contacts', 'read')
  if (err) return err

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const empty = { monto_cargas_mes: 0, monto_retiros_mes: 0, last_deposit_at: null, mes_referencia: null, fuente: null }

  try {
    const [contact] = await query<{ first_name: string | null; last_name: string | null }>(
      'SELECT first_name, last_name FROM contacts WHERE id = $1', [id]
    )
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

    // Candidatos de username: raw + sin prefijo "Z/ " para first_name y last_name
    const raw = [contact.first_name, contact.last_name]
    const candidates = [...new Set(
      raw
        .filter(Boolean)
        .flatMap(s => [s!.trim().toLowerCase(), extractUsername(s!)])
        .filter(s => s.length > 0)
    )]

    if (candidates.length === 0) return NextResponse.json(empty)

    // Buscar el username real en casino_players
    const cpRows = await query<{ username: string; total_cargas: number; fecha_ultima: string | null }>(
      `SELECT username, total_cargas, fecha_ultima
       FROM casino_players
       WHERE username_lower = ANY($1::text[])
       LIMIT 1`,
      [candidates]
    )

    if (!cpRows.length) return NextResponse.json(empty)

    const username = cpRows[0].username.toLowerCase()

    // Intentar obtener datos del último mes con actividad desde casino_transactions
    const txRows = await query<{
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
        COALESCE(SUM(CASE WHEN ct.tipo = 'carga'  AND DATE_TRUNC('month', ct.fecha) = um.mes THEN ct.monto      ELSE 0 END), 0)::int AS monto_cargas_mes,
        COALESCE(SUM(CASE WHEN ct.tipo = 'retiro' AND DATE_TRUNC('month', ct.fecha) = um.mes THEN ABS(ct.monto) ELSE 0 END), 0)::int AS monto_retiros_mes,
        MAX(CASE WHEN ct.tipo = 'carga' THEN ct.fecha END) AS last_deposit_at,
        TO_CHAR(um.mes, 'Mon YYYY') AS mes_referencia
      FROM casino_transactions ct
      CROSS JOIN ultimo_mes um
      WHERE LOWER(ct.username) = $1
        AND um.mes IS NOT NULL
      GROUP BY um.mes
    `, [username])

    if (txRows.length > 0 && (txRows[0].monto_cargas_mes > 0 || txRows[0].monto_retiros_mes > 0)) {
      return NextResponse.json({ ...txRows[0], fuente: 'transactions' })
    }

    // Fallback: usar casino_players (datos históricos agregados)
    const cp = cpRows[0]
    return NextResponse.json({
      monto_cargas_mes: cp.total_cargas ?? 0,
      monto_retiros_mes: 0,
      last_deposit_at: cp.fecha_ultima ?? null,
      mes_referencia: null,
      fuente: 'historico',
    })
  } catch (e) {
    console.error('[/api/contacts/[id]/casino-stats]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
