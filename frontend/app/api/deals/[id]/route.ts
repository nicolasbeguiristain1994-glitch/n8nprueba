import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import type { DealStage } from '@/components/kanban/types'

type Params = { params: Promise<{ id: string }> }

// PATCH /api/deals/[id] — actualizar stage, position, o campos del deal
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await checkPermissionWithUser(req, 'pipeline', 'update')
  if (!auth.ok) return auth.response

  const { id } = await params
  const dealId = Number(id)
  if (isNaN(dealId)) return NextResponse.json({ error: 'id inválido' }, { status: 400 })

  const body = await req.json()
  const allowed = ['title', 'amount', 'stage', 'contact_id', 'owner_id', 'close_date', 'notes', 'position'] as const
  type AllowedKey = typeof allowed[number]

  const sets: string[] = []
  const values: unknown[] = []
  let pIdx = 1

  for (const key of allowed) {
    if (key in body) {
      sets.push(`${key} = $${pIdx++}`)
      values.push(body[key as AllowedKey] ?? null)
    }
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: 'Sin campos a actualizar' }, { status: 400 })
  }

  values.push(dealId)
  await query(
    `UPDATE deals SET ${sets.join(', ')} WHERE id = $${pIdx}`,
    values,
  )

  // Si se movió a otra columna, reordenar posiciones en la nueva columna
  if ('stage' in body && 'position' in body) {
    const stage = body.stage as DealStage
    await query(
      `UPDATE deals SET position = sub.rn - 1
       FROM (
         SELECT id, ROW_NUMBER() OVER (ORDER BY position, id) AS rn
         FROM deals WHERE stage = $1
       ) sub
       WHERE deals.id = sub.id`,
      [stage],
    )
  }

  return NextResponse.json({ ok: true })
}

// DELETE /api/deals/[id]
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await checkPermissionWithUser(req, 'pipeline', 'delete')
  if (!auth.ok) return auth.response

  const { id } = await params
  const dealId = Number(id)
  if (isNaN(dealId)) return NextResponse.json({ error: 'id inválido' }, { status: 400 })

  await query('DELETE FROM deals WHERE id = $1', [dealId])
  return NextResponse.json({ ok: true })
}
