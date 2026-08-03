import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

// GET /api/reports?page=1&export=1
export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth

  const sp       = req.nextUrl.searchParams
  const isExport = sp.get('export') === '1'
  const page     = Math.max(1, parseInt(sp.get('page') || '1'))
  const limit    = isExport ? 10000 : 50
  const offset   = isExport ? 0 : (page - 1) * limit

  // Admins ven todo; operadores solo sus registros
  const isAdmin   = user.role === 'admin'
  const whereClause = isAdmin
    ? 'WHERE 1=1'
    : 'WHERE operador_id = $1'
  const params: unknown[] = isAdmin ? [] : [String(user.user_id)]

  try {
    const [rows, countRows] = await Promise.all([
      query(
        `SELECT * FROM sending_reports ${whereClause}
         ORDER BY fecha DESC, created_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      query(
        `SELECT COUNT(*) AS total FROM sending_reports ${whereClause}`,
        params,
      ),
    ])

    return NextResponse.json({
      reports: rows,
      total: Number(countRows[0]?.total ?? 0),
    })
  } catch (e) {
    console.error('[/api/reports GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

// POST /api/reports  — registrar fin de jornada
export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Body inválido' }, { status: 400 })
  }

  const { oficina, linea, base_datos, mensaje, segmentacion, enviados, observaciones, fecha, respuestas, cargas } = body

  if (!oficina || !linea || !base_datos || !mensaje || enviados == null) {
    return NextResponse.json({ error: 'Faltan campos obligatorios' }, { status: 400 })
  }

  const u = user as Record<string, unknown>
  const operadorNombre = String(u.name ?? u.display_name ?? u.username ?? u.email ?? 'Operador')
  const respVal = respuestas != null ? Number(respuestas) : null
  const cargasVal = cargas != null ? Number(cargas) : null
  const estado = (respVal != null && cargasVal != null) ? 'completo' : 'pendiente'

  try {
    const rows = await query(
      `INSERT INTO sending_reports
         (oficina, linea, base_datos, mensaje, segmentacion, enviados, respuestas, cargas, observaciones, fecha, operador_id, operador_nombre, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        String(oficina), Number(linea), String(base_datos), String(mensaje),
        segmentacion ? String(segmentacion) : null, Number(enviados),
        respVal, cargasVal,
        observaciones ? String(observaciones) : null,
        fecha ? String(fecha) : new Date().toISOString().slice(0, 10),
        String(user.user_id), operadorNombre, estado,
      ],
    )
    return NextResponse.json({ report: rows[0] }, { status: 201 })
  } catch (e) {
    console.error('[/api/reports POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
