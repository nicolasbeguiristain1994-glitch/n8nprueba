import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { parseBody, handleValidationError, CreateWarmupSchema } from '@/lib/schema'
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
             COALESCE(l.total_sent, 0)::int AS total_messages_sent,
             COALESCE(w.health_score, 50)::int AS health_score,
             w.health_updated_at
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

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(CreateWarmupSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'warmup')

  const { phone_number, instance_name, display_name,
          target_days: resolvedDays, daily_limit: resolvedLimit,
          notes, timezone, delay_preset: resolvedPreset } = parsed.data

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

  const doInsert = () => query(`
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

  try {
    const rows = await doInsert()
    const newId = (rows[0] as { id: string }).id
    void audit({ req, action: 'create', resource: 'warmup', resource_id: newId,
      metadata: { instance_name: instance_name.trim() } })
    emitWarmupChange()
    return NextResponse.json({ id: newId })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)

    // Auto-fix: columnas faltantes en la DB de producción (schema desfasado).
    // Aplicar el ALTER TABLE y reintentar una vez.
    if (msg.includes('does not exist') && msg.includes('column')) {
      console.warn('[/api/warmup POST] columna faltante, aplicando fix de schema…', msg)
      try {
        await query(`
          ALTER TABLE warmup_numbers
            ADD COLUMN IF NOT EXISTS display_name          VARCHAR(100),
            ADD COLUMN IF NOT EXISTS evolution_url         VARCHAR(255),
            ADD COLUMN IF NOT EXISTS delay_preset          VARCHAR(20)   DEFAULT 'normal',
            ADD COLUMN IF NOT EXISTS delay_min_seconds     INTEGER       DEFAULT 45,
            ADD COLUMN IF NOT EXISTS delay_max_seconds     INTEGER       DEFAULT 180,
            ADD COLUMN IF NOT EXISTS sending_window_start  TIME          DEFAULT '09:00',
            ADD COLUMN IF NOT EXISTS sending_window_end    TIME          DEFAULT '22:00',
            ADD COLUMN IF NOT EXISTS active_days           INTEGER[]     DEFAULT '{1,2,3,4,5,6,7}',
            ADD COLUMN IF NOT EXISTS anti_ban_enabled      BOOLEAN       DEFAULT false,
            ADD COLUMN IF NOT EXISTS randomness_level      VARCHAR(10)   DEFAULT 'medium',
            ADD COLUMN IF NOT EXISTS natural_distribution  BOOLEAN       DEFAULT false
        `)
        const rows = await doInsert()
        const newId = (rows[0] as { id: string }).id
        void audit({ req, action: 'create', resource: 'warmup', resource_id: newId,
          metadata: { instance_name: instance_name.trim() } })
        emitWarmupChange()
        return NextResponse.json({ id: newId })
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
        console.error('[/api/warmup POST] retry failed after schema fix:', retryMsg)
        return NextResponse.json({ error: `Internal server error` }, { status: 500 })
      }
    }

    console.error('[/api/warmup POST]', msg)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
