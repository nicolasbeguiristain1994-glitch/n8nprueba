import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { emitWarmupChange } from '@/lib/warmup-sse'

const ALLOWED_WARMUP_STATUSES = ['active', 'paused', 'completed', 'banned']

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const err = await checkPermission(req, 'warmup', 'update')
  if (err) return err

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

  const VALID_PRESETS = ['conservadora', 'normal', 'agresiva']
  if ('delay_preset' in body && !VALID_PRESETS.includes(body.delay_preset as string))
    return NextResponse.json({ error: 'delay_preset inválido' }, { status: 400 })

  const VALID_RANDOMNESS = ['low', 'medium', 'high']
  if ('randomness_level' in body && !VALID_RANDOMNESS.includes(body.randomness_level as string))
    return NextResponse.json({ error: 'randomness_level inválido. Valores: low, medium, high' }, { status: 400 })

  const allowed = [
    'warmup_status', 'daily_limit', 'target_days', 'notes', 'display_name', 'delay_preset',
    'anti_ban_enabled', 'delay_min_seconds', 'delay_max_seconds',
    'sending_window_start', 'sending_window_end', 'active_days',
    'randomness_level', 'natural_distribution',
  ]
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
    const updated = await query<{ id: string }>(
      `UPDATE warmup_numbers SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING id`,
      values
    )
    if (!updated[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    void audit({ req, action: 'update', resource: 'warmup', resource_id: id,
      metadata: { changedFields: allowed.filter(k => k in body) } })
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
