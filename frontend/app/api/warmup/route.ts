import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isE164, isInstanceName } from '@/lib/validate'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { getAppSetting } from '@/lib/app-settings'
import { emitWarmupChange } from '@/lib/warmup-sse'

export async function GET(req: Request) {
  const err = await checkPermission(req, 'warmup', 'read')
  if (err) return err

  try {
    const numbers = await query(`
      SELECT w.id, w.phone_number, w.instance_name, w.display_name, w.warmup_status,
             w.current_day, w.target_days, w.messages_sent_today, w.daily_limit,
             w.last_message_at, w.start_date, w.notes, w.timezone,
             COALESCE(w.delay_preset, 'normal') AS delay_preset,
             w.anti_ban_enabled,
             COALESCE(l.total_sent, 0)::int AS total_messages_sent
      FROM warmup_numbers w
      LEFT JOIN (
        SELECT warmup_number_id, COUNT(*) AS total_sent
        FROM warmup_activity_log WHERE status = 'sent'
        GROUP BY warmup_number_id
      ) l ON l.warmup_number_id = w.id
      ORDER BY w.created_at DESC
    `)
    return NextResponse.json({ numbers })
  } catch (e) {
    console.error('[/api/warmup GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'warmup', 'create')
  if (err) return err

  let body: {
    phone_number?: string; instance_name?: string; display_name?: string
    target_days?: number; daily_limit?: number; notes?: string; timezone?: string
    delay_preset?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { phone_number, instance_name, display_name, target_days = 21, daily_limit = 10, notes, timezone, delay_preset = 'normal' } = body
  const validPresets = ['conservadora', 'normal', 'agresiva']
  const resolvedPreset = validPresets.includes(delay_preset) ? delay_preset : 'normal'

  if (!phone_number || !instance_name) {
    return NextResponse.json({ error: 'phone_number e instance_name son requeridos' }, { status: 400 })
  }
  if (!isE164(phone_number)) {
    return NextResponse.json({ error: 'phone_number debe estar en formato E.164 (ej: +5491112345678)' }, { status: 400 })
  }
  if (!isInstanceName(instance_name)) {
    return NextResponse.json({ error: 'instance_name inválido (solo letras, números, _ y -, máx 64 caracteres)' }, { status: 400 })
  }
  const resolvedDays  = Math.floor(Number(target_days))
  const resolvedLimit = Math.floor(Number(daily_limit))
  if (!Number.isFinite(resolvedDays) || resolvedDays < 1) {
    return NextResponse.json({ error: 'target_days debe ser un entero positivo' }, { status: 400 })
  }
  if (!Number.isFinite(resolvedLimit) || resolvedLimit < 1) {
    return NextResponse.json({ error: 'daily_limit debe ser un entero positivo' }, { status: 400 })
  }

  // Verificar límite global de líneas en calentamiento
  const maxWarmup = await getAppSetting<number>('limits_max_warmup_lines', 20)
  const countResult = await query<{ count: number }>('SELECT COUNT(*)::int AS count FROM warmup_numbers')
  const currentCount = countResult[0]?.count ?? 0
  if (currentCount >= maxWarmup) {
    return NextResponse.json(
      { error: `Límite alcanzado: no se pueden agregar más de ${maxWarmup} líneas de calentamiento` },
      { status: 400 }
    )
  }

  try {
    const rows = await query(`
      INSERT INTO warmup_numbers (phone_number, instance_name, display_name, target_days, daily_limit, notes, timezone, delay_preset)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `, [
      phone_number.trim(),
      instance_name.trim(),
      display_name?.trim() || null,
      resolvedDays,
      resolvedLimit,
      notes || null,
      timezone || 'America/Argentina/Buenos_Aires',
      resolvedPreset,
    ])

    const newId = (rows[0] as { id: string }).id
    void audit({ req, action: 'create', resource: 'warmup', resource_id: newId,
      metadata: { instance_name: instance_name.trim() } })
    emitWarmupChange()
    return NextResponse.json({ id: newId })
  } catch (e) {
    console.error('[/api/warmup POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
