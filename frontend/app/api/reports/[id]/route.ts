import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'

type Ctx = { params: Promise<{ id: string }> }

// PATCH /api/reports/:id  — cargar efectividad
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth
  const { id } = await ctx.params

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Body inválido' }, { status: 400 })
  }

  if (user.role !== 'admin') {
    const existing = await query<{ operador_id: string }>(
      'SELECT operador_id FROM sending_reports WHERE id = $1', [id],
    )
    if (!existing[0] || existing[0].operador_id !== String(user.user_id)) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 403 })
    }
  }

  const respuestas    = body.respuestas    != null ? Number(body.respuestas)    : null
  const cargas        = body.cargas        != null ? Number(body.cargas)        : null
  const observaciones = body.observaciones != null ? String(body.observaciones) : null
  const estadoSql     = (respuestas != null && cargas != null) ? `'completo'` : `estado`

  try {
    const rows = await query(
      `UPDATE sending_reports
       SET respuestas    = COALESCE($1, respuestas),
           cargas        = COALESCE($2, cargas),
           observaciones = COALESCE($3, observaciones),
           estado        = ${estadoSql},
           updated_at    = NOW()
       WHERE id = $4 RETURNING *`,
      [respuestas, cargas, observaciones, id],
    )
    if (!rows[0]) return NextResponse.json({ error: 'No encontrado' }, { status: 404 })
    return NextResponse.json({ report: rows[0] })
  } catch (e) {
    console.error('[/api/reports/:id PATCH]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}

// DELETE /api/reports/:id
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'read')
  if (!auth.ok) return auth.response
  const { user } = auth
  const { id } = await ctx.params

  if (user.role !== 'admin') {
    const existing = await query<{ operador_id: string }>(
      'SELECT operador_id FROM sending_reports WHERE id = $1', [id],
    )
    if (!existing[0] || existing[0].operador_id !== String(user.user_id)) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 403 })
    }
  }

  try {
    await query('DELETE FROM sending_reports WHERE id = $1', [id])
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/reports/:id DELETE]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Error interno' }, { status: 500 })
  }
}
