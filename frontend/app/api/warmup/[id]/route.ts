import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'

const ALLOWED_WARMUP_STATUSES = ['active', 'paused', 'completed', 'banned']

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Validate warmup_status if provided
  if ('warmup_status' in body) {
    if (!ALLOWED_WARMUP_STATUSES.includes(body.warmup_status as string)) {
      return NextResponse.json({
        error: `warmup_status inválido. Valores permitidos: ${ALLOWED_WARMUP_STATUSES.join(', ')}`
      }, { status: 400 })
    }
  }

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
  try {
    await query(
      `UPDATE warmup_numbers SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`,
      values
    )
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/warmup PATCH]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    await query(`DELETE FROM warmup_numbers WHERE id = $1`, [id])
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/warmup DELETE]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
