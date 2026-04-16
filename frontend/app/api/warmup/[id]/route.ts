import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()

  const allowed = ['warmup_status', 'daily_limit', 'target_days', 'notes', 'display_name']
  const updates: string[] = []
  const values: unknown[] = []

  for (const key of allowed) {
    if (key in body) {
      values.push(body[key])
      updates.push(`${key} = $${values.length}`)
    }
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: 'Nada que actualizar' }, { status: 400 })
  }

  values.push(id)
  await query(
    `UPDATE warmup_numbers SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`,
    values
  )

  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await query(`DELETE FROM warmup_numbers WHERE id = $1`, [id])
  return NextResponse.json({ ok: true })
}
