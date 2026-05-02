import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isE164, isInstanceName } from '@/lib/validate'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { getAppSetting } from '@/lib/app-settings'

export async function GET(req: Request) {
  const err = await checkPermission(req, 'warmup', 'read')
  if (err) return err

  try {
    const numbers = await query(`
      SELECT id, phone_number, instance_name, display_name, warmup_status, current_day, target_days,
             messages_sent_today, daily_limit, last_message_at, start_date, notes, timezone
      FROM warmup_numbers
      ORDER BY created_at DESC
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
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { phone_number, instance_name, display_name, target_days = 14, daily_limit = 10, notes, timezone } = body

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
      INSERT INTO warmup_numbers (phone_number, instance_name, display_name, target_days, daily_limit, notes, timezone)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `, [
      phone_number.trim(),
      instance_name.trim(),
      display_name?.trim() || null,
      resolvedDays,
      resolvedLimit,
      notes || null,
      timezone || 'America/Argentina/Buenos_Aires',
    ])

    const newId = (rows[0] as { id: string }).id
    void audit({ req, action: 'create', resource: 'warmup', resource_id: newId,
      metadata: { instance_name: instance_name.trim() } })
    return NextResponse.json({ id: newId })
  } catch (e) {
    console.error('[/api/warmup POST]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
