/**
 * GET /api/users/[id]/visibility/available
 *
 * Contactos que NO están asignados aún al operador.
 * Usado en el panel dual-list para elegir qué asignar.
 * Solo admin.
 */

import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: RouteContext) {
  const auth = await checkPermissionWithUser(req, 'users', 'manage')
  if (!auth.ok) return auth.response

  const { id: operatorId } = await params
  if (!isUUID(operatorId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const search  = req.nextUrl.searchParams.get('q') || ''
  const panel   = req.nextUrl.searchParams.get('panel') || ''
  const segment = req.nextUrl.searchParams.get('segment') || ''
  const linea   = req.nextUrl.searchParams.get('linea') || ''
  const page    = Math.max(1, Number(req.nextUrl.searchParams.get('page') || 1))
  const limit   = 50
  const offset  = (page - 1) * limit

  try {
    const [contacts, countResult] = await Promise.all([
      query(`
        SELECT c.id, c.phone_number, c.first_name, c.last_name, c.segment, c.panel, c.linea
        FROM contacts c
        WHERE NOT EXISTS (
          SELECT 1 FROM operator_contact_visibility ocv
          WHERE ocv.contact_id = c.id AND ocv.operator_id = $1
        )
          AND ($2 = '' OR c.phone_number ILIKE $2 OR c.first_name ILIKE $2 OR c.last_name ILIKE $2)
          AND ($3 = '' OR c.panel = $3)
          AND ($4 = '' OR c.segment::text = $4)
          AND ($5 = '' OR c.linea::text = $5)
        ORDER BY c.created_at DESC
        LIMIT $6 OFFSET $7
      `, [operatorId, `%${search}%`, panel, segment, linea, limit, offset]),

      query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM contacts c
        WHERE NOT EXISTS (
          SELECT 1 FROM operator_contact_visibility ocv
          WHERE ocv.contact_id = c.id AND ocv.operator_id = $1
        )
          AND ($2 = '' OR c.phone_number ILIKE $2 OR c.first_name ILIKE $2 OR c.last_name ILIKE $2)
          AND ($3 = '' OR c.panel = $3)
          AND ($4 = '' OR c.segment::text = $4)
          AND ($5 = '' OR c.linea::text = $5)
      `, [operatorId, `%${search}%`, panel, segment, linea]),
    ])

    return NextResponse.json({
      contacts,
      total: Number(countResult[0]?.count ?? 0),
      page,
    })
  } catch (e) {
    console.error('[/api/users/[id]/visibility/available GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
