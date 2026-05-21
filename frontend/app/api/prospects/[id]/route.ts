import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermissionWithUser } from '@/lib/permissions'

type Params = { params: Promise<{ id: string }> }

// PATCH /api/prospects/[id]
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'manage')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  let body: {
    first_name?: string | null
    last_name?:  string | null
    email?:      string | null
    notes?:      string | null
    status?:     string
    stage?:      string
    opt_in?:     boolean
    tags?:       string[]
  }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (body.status && !['active', 'unsubscribed'].includes(body.status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }
  if (body.stage && !['nuevo', 'contactado', 'interesado', 'descartado'].includes(body.stage)) {
    return NextResponse.json({ error: 'Invalid stage' }, { status: 400 })
  }

  // Pre-check combinado: validar invariantes de estado antes de aplicar cambios.
  // - Un prospecto 'converted' no puede cambiar su status (la conversión es terminal).
  // - Solo prospectos 'active' pueden cambiar su stage.
  if (body.status || body.stage) {
    try {
      const [prospect] = await query<{ status: string }>(
        'SELECT status FROM prospects WHERE id = $1',
        [id]
      )
      if (!prospect) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
      }
      if (body.status && prospect.status === 'converted') {
        return NextResponse.json(
          { error: 'No se puede modificar el estado de un prospecto convertido.' },
          { status: 409 }
        )
      }
      if (body.stage && prospect.status !== 'active') {
        return NextResponse.json(
          { error: `No se puede cambiar la etapa de un prospecto en estado '${prospect.status}'. Solo los prospectos activos pueden modificar su etapa.` },
          { status: 409 }
        )
      }
    } catch (e) {
      console.error('[PATCH /api/prospects/[id]] pre-check:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  }

  // Query dinámica: solo actualiza los campos explícitamente provistos.
  // null significa "borrar el campo"; undefined (no incluido en el body) = no tocar.
  const sets: string[] = []
  const vals: unknown[] = [id]
  let p = 2

  if (body.first_name !== undefined) { sets.push(`first_name = $${p++}`);          vals.push(body.first_name) }
  if (body.last_name  !== undefined) { sets.push(`last_name  = $${p++}`);          vals.push(body.last_name) }
  if (body.email      !== undefined) { sets.push(`email      = $${p++}`);          vals.push(body.email) }
  if (body.notes      !== undefined) { sets.push(`notes      = $${p++}`);          vals.push(body.notes) }
  if (body.status)                   { sets.push(`status     = $${p++}`);          vals.push(body.status) }
  if (body.stage)                    { sets.push(`stage      = $${p++}`);          vals.push(body.stage) }
  if (body.opt_in     !== undefined) { sets.push(`opt_in     = $${p++}`);          vals.push(body.opt_in) }
  if (body.tags       !== undefined) { sets.push(`tags       = $${p++}::text[]`);  vals.push(body.tags) }

  if (sets.length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  sets.push('updated_at = NOW()')

  try {
    const [row] = await query<{ id: string }>(
      `UPDATE prospects SET ${sets.join(', ')} WHERE id = $1 RETURNING id`,
      vals
    )
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[PATCH /api/prospects/[id]]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// DELETE /api/prospects/[id]
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'manage')
  if (!auth.ok) return auth.response

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  try {
    const [existing] = await query<{ status: string }>(
      'SELECT status FROM prospects WHERE id = $1',
      [id]
    )
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (existing.status === 'converted') {
      return NextResponse.json(
        { error: 'No se puede eliminar un prospecto convertido' },
        { status: 409 }
      )
    }

    await query(`DELETE FROM prospects WHERE id = $1`, [id])
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[DELETE /api/prospects/[id]]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
