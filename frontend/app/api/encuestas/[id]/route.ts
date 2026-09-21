import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { isUUID } from '@/lib/validate'
import { parseBody, handleValidationError } from '@/lib/schema'
import { EncuestaPatchSchema, type Question } from '@/lib/encuestas'

// GET /api/encuestas/[id] — detalle para el editor.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const auth = await checkPermissionWithUser(req, 'encuestas', 'read')
  if (!auth.ok) return auth.response

  const rows = await query<{
    id: string; slug: string; title: string; description: string | null
    questions: Question[]; is_active: boolean
    created_at: string; updated_at: string
  }>(
    `SELECT id, slug, title, description, questions, is_active, created_at, updated_at
       FROM encuestas WHERE id = $1 LIMIT 1`,
    [id],
  )
  const row = rows[0]
  if (!row) return NextResponse.json({ error: 'No encontrada' }, { status: 404 })
  return NextResponse.json(row)
}

// PATCH /api/encuestas/[id] — editar cualquier subconjunto de campos.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const auth = await checkPermissionWithUser(req, 'encuestas', 'update')
  if (!auth.ok) return auth.response

  const body = await req.json().catch(() => null)
  const parsed = parseBody(EncuestaPatchSchema, body)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'encuestas')

  const d = parsed.data
  if (Object.keys(d).length === 0) {
    return NextResponse.json({ error: 'Nada para actualizar' }, { status: 400 })
  }

  if (d.questions) {
    const ids = new Set<string>()
    for (const q of d.questions) {
      if (ids.has(q.id)) return NextResponse.json({ error: `ID duplicado: ${q.id}` }, { status: 400 })
      ids.add(q.id)
    }
  }

  // Construimos SET dinámico con placeholders numerados.
  const sets: string[] = []
  const vals: unknown[] = []
  let i = 1
  if (d.slug        !== undefined) { sets.push(`slug = $${i++}`);        vals.push(d.slug) }
  if (d.title       !== undefined) { sets.push(`title = $${i++}`);       vals.push(d.title) }
  if (d.description !== undefined) { sets.push(`description = $${i++}`); vals.push(d.description ?? null) }
  if (d.questions   !== undefined) { sets.push(`questions = $${i++}::jsonb`); vals.push(JSON.stringify(d.questions)) }
  if (d.is_active   !== undefined) { sets.push(`is_active = $${i++}`);   vals.push(d.is_active) }

  vals.push(id)

  try {
    const res = await query<{ id: string }>(
      `UPDATE encuestas SET ${sets.join(', ')} WHERE id = $${i} RETURNING id`,
      vals,
    )
    if (res.length === 0) return NextResponse.json({ error: 'No encontrada' }, { status: 404 })
    void audit({ req, action: 'update', resource: 'encuestas', resource_id: id, metadata: { fields: Object.keys(d) } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('encuestas_slug_key')) {
      return NextResponse.json({ error: 'El slug ya está en uso' }, { status: 409 })
    }
    console.error('[/api/encuestas/[id] PATCH]', msg)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// DELETE /api/encuestas/[id] — borra encuesta y respuestas (cascade en FK).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const auth = await checkPermissionWithUser(req, 'encuestas', 'delete')
  if (!auth.ok) return auth.response

  const res = await query<{ id: string }>(`DELETE FROM encuestas WHERE id = $1 RETURNING id`, [id])
  if (res.length === 0) return NextResponse.json({ error: 'No encontrada' }, { status: 404 })
  void audit({ req, action: 'delete', resource: 'encuestas', resource_id: id })
  return NextResponse.json({ ok: true })
}
