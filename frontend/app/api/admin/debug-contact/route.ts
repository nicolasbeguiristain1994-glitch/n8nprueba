import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'

/**
 * GET /api/admin/debug-contact?username=loreley37z2
 * Diagnóstico: muestra raw data de casino_players, casino_transactions y contacts para un username.
 */
export async function GET(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err

  const username = (req.nextUrl.searchParams.get('username') || '').toLowerCase().trim()
  if (!username) return NextResponse.json({ error: 'username requerido' }, { status: 400 })

  const [playerRows, txRows, contactRows, hasTxRows, joinRows, sampleJoin] = await Promise.all([
    query(`SELECT * FROM casino_players WHERE username_lower = $1`, [username]),
    query(`SELECT COUNT(*) AS total, MIN(fecha) AS primera, MAX(fecha) AS ultima, SUM(monto) AS suma
           FROM casino_transactions WHERE LOWER(username) = $1 AND tipo = 'carga'`, [username]),
    query(`SELECT id, first_name, octet_length(first_name) AS fn_bytes, segment, last_deposit_at, total_deposits,
                  ARRAY(SELECT tag FROM contact_tags WHERE contact_id = contacts.id AND tag LIKE 'casino:%' ORDER BY tag) AS casino_tag_list
           FROM contacts WHERE LOWER(TRIM(first_name)) = $1`, [username]),
    query(`SELECT EXISTS(SELECT 1 FROM casino_transactions WHERE tipo = 'carga') AS any_tx,
                  COUNT(*) AS total_tx_global FROM casino_transactions WHERE tipo = 'carga'`),
    // Verificar si el JOIN funciona para este usuario específico
    query(`SELECT c.id, c.first_name, cp.username_lower, cp.seg_actividad, cp.seg_monto, cp.cant_cargas
           FROM contacts c
           JOIN casino_players cp ON LOWER(TRIM(c.first_name)) = cp.username_lower
           WHERE LOWER(TRIM(c.first_name)) = $1`, [username]),
    // Ver una muestra global del JOIN (cuántas filas coinciden en total)
    query(`SELECT COUNT(*) AS total_join_matches FROM contacts c
           JOIN casino_players cp ON LOWER(TRIM(c.first_name)) = cp.username_lower`),
  ])

  return NextResponse.json({
    username,
    casino_players:       playerRows,
    casino_transactions:  txRows[0],
    contacts:             contactRows,
    global_tx_exists:     hasTxRows[0],
    join_test:            joinRows,          // debe tener 1 fila si el JOIN funciona
    total_join_matches:   sampleJoin[0],     // cuántos contactos en total matchean casino_players
  })
}
