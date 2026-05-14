import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { emitWarmupChange } from '@/lib/warmup-sse'
import { parseBody, handleValidationError, PatchWarmupSchema } from '@/lib/schema'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const err = await checkPermission(req, 'warmup', 'update')
  if (err) return err

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(PatchWarmupSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'warmup')

  const data = parsed.data
  const PATCH_FIELDS = [
    'warmup_status', 'daily_limit', 'target_days', 'notes', 'display_name', 'delay_preset',
    'anti_ban_enabled', 'delay_min_seconds', 'delay_max_seconds',
    'sending_window_start', 'sending_window_end', 'active_days',
    'randomness_level', 'natural_distribution',
  ] as const

  const updates: string[] = []
  const values: unknown[] = []

  for (const key of PATCH_FIELDS) {
    const value = data[key]
    if (value !== undefined) {
      values.push(value)
      updates.push(`${key} = $${values.length}`)
    }
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: 'Nada que actualizar' }, { status: 400 })
  }

  values.push(id)
  try {
    const updated = await query<{ id: string }>(
      `UPDATE warmup_numbers SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING id`,
      values
    )
    if (!updated[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    void audit({ req, action: 'update', resource: 'warmup', resource_id: id,
      metadata: { changedFields: PATCH_FIELDS.filter(k => data[k] !== undefined) } })
    emitWarmupChange()
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/warmup PATCH]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // delete = admin-only (operator canAccess blocks delete action)
  const err = await checkPermission(req, 'warmup', 'delete')
  if (err) return err

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  try {
    const deleted = await query<{ id: string }>(`DELETE FROM warmup_numbers WHERE id = $1 RETURNING id`, [id])
    if (!deleted[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    void audit({ req, action: 'delete', resource: 'warmup', resource_id: id })
    emitWarmupChange()
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[/api/warmup DELETE]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
