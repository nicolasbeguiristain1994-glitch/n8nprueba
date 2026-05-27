import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { getAllWithSource, validateScoringConfig } from '@/lib/scoring-config-service'
import type { ScoringConfigKey } from '@/lib/scoring-config-service'
import { getConfigRedisClient } from '@/lib/redis'

const WORKSPACE = 'default'

const VALID_KEYS: ScoringConfigKey[] = [
  'urgency_score_max',
  'risk_weight_daily',
  'risk_weight_weekly',
  'risk_weight_cooldown',
  'allow_threshold',
  'delay_threshold',
  'cooldown_multiplier',
]

// Campos críticos: requieren reason ≥ 10 caracteres
const CRITICAL_KEYS: ScoringConfigKey[] = ['allow_threshold', 'delay_threshold']

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'settings', 'read')
  if (!auth.ok) return auth.response

  try {
    const { config, source } = await getAllWithSource()

    // config_updated_at: timestamp máximo de cualquier key, para control de concurrencia en PATCH
    const metaRows = await query<{ max_updated_at: string | null }>(
      `SELECT MAX(updated_at)::text AS max_updated_at FROM scoring_config WHERE workspace_id = $1`,
      [WORKSPACE],
    )
    const config_updated_at = metaRows[0]?.max_updated_at ?? null

    return NextResponse.json({ config, source, config_updated_at })
  } catch (e) {
    console.error('[/api/settings/scoring GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── PATCH ─────────────────────────────────────────────────────────────────────

type PatchBody = {
  changes: Partial<Record<ScoringConfigKey, number>>
  reason?: string
  updated_at: string
}

export async function PATCH(req: NextRequest) {
  // 1. Auth: solo admins pueden modificar
  const auth = await checkPermissionWithUser(req, 'settings', 'manage')
  if (!auth.ok) return auth.response

  if (auth.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: solo administradores pueden modificar la configuración' }, { status: 403 })
  }

  // 2. Parsear body
  let body: PatchBody
  try {
    body = await req.json() as PatchBody
  } catch {
    return NextResponse.json({ error: 'Body inválido: se esperaba JSON' }, { status: 400 })
  }

  const { changes, reason, updated_at: clientUpdatedAt } = body

  if (!changes || typeof changes !== 'object' || Object.keys(changes).length === 0) {
    return NextResponse.json({ error: 'changes no puede estar vacío' }, { status: 400 })
  }
  if (!clientUpdatedAt || typeof clientUpdatedAt !== 'string') {
    return NextResponse.json({ error: 'updated_at es requerido para control de concurrencia' }, { status: 400 })
  }

  // Filtrar solo keys válidas
  const sanitizedChanges: Partial<Record<ScoringConfigKey, number>> = {}
  for (const [key, val] of Object.entries(changes)) {
    if (VALID_KEYS.includes(key as ScoringConfigKey) && typeof val === 'number') {
      sanitizedChanges[key as ScoringConfigKey] = val
    }
  }
  if (Object.keys(sanitizedChanges).length === 0) {
    return NextResponse.json({ error: 'Ninguna key válida en changes' }, { status: 400 })
  }

  // 3. Validar con la función del servicio
  const validationErrors = validateScoringConfig(sanitizedChanges)
  if (validationErrors.length > 0) {
    return NextResponse.json({ error: 'Validación fallida', errors: validationErrors }, { status: 400 })
  }

  // 4. Verificar reason para campos críticos
  const hasCriticalChange = CRITICAL_KEYS.some(k => k in sanitizedChanges)
  if (hasCriticalChange && (!reason || reason.trim().length < 10)) {
    return NextResponse.json({
      error: 'allow_threshold y delay_threshold requieren un motivo de al menos 10 caracteres',
    }, { status: 400 })
  }

  // 5. Concurrencia optimista: verificar MAX(updated_at) de las keys en changes
  const changedKeys = Object.keys(sanitizedChanges) as ScoringConfigKey[]
  try {
    const rows = await query<{ max_updated_at: string }>(
      `SELECT MAX(updated_at)::text AS max_updated_at
       FROM scoring_config
       WHERE workspace_id = $1 AND key = ANY($2::text[])`,
      [WORKSPACE, changedKeys],
    )
    const dbTs     = rows[0]?.max_updated_at ? new Date(rows[0].max_updated_at).getTime() : 0
    const clientTs = new Date(clientUpdatedAt).getTime()
    if (dbTs !== clientTs) {
      return NextResponse.json({
        error: 'El registro fue modificado por otro usuario. Refrescá la página.',
      }, { status: 409 })
    }
  } catch (e) {
    console.error('[/api/settings/scoring PATCH] Concurrency check error', e)
    return NextResponse.json({ error: 'Error al verificar estado actual' }, { status: 500 })
  }

  // 6. Simulación de impacto para scoring_config:
  //    El impacto real requiere recalcular risk scores desde historial de envíos,
  //    lo cual excede el scope de un endpoint síncrono. Se retorna -1 con nota.
  const affectedContacts = -1
  const impactNote = 'El impacto en decisiones ALLOW/DELAY/BLOCK será visible en la próxima evaluación del engine. Los cambios en umbrales son efectivos de inmediato para nuevas evaluaciones.'

  // 7. UPDATE de cada key (el trigger escribe en settings_audit_log por cada una)
  try {
    for (const [key, value] of Object.entries(sanitizedChanges)) {
      await query(
        `UPDATE scoring_config
         SET value = $1, updated_by = $2, updated_at = NOW()
         WHERE key = $3 AND workspace_id = $4`,
        [value, auth.user.user_id, key, WORKSPACE],
      )
    }
  } catch (e) {
    console.error('[/api/settings/scoring PATCH] UPDATE error', e)
    return NextResponse.json({ error: 'Error al guardar los cambios' }, { status: 500 })
  }

  // 8. Enriquecer audit log con reason para cada key modificada
  //    El trigger ya insertó las filas; este UPDATE agrega el motivo.
  if (reason?.trim()) {
    for (const key of changedKeys) {
      try {
        await query(
          `UPDATE settings_audit_log
           SET reason = $1
           WHERE id = (
             SELECT id FROM settings_audit_log
             WHERE table_name = 'scoring_config'
               AND record_id = $2
               AND operation = 'UPDATE'
             ORDER BY changed_at DESC
             LIMIT 1
           )`,
          [reason.trim(), `${key}:${WORKSPACE}`],
        )
      } catch (e) {
        console.warn(`[/api/settings/scoring PATCH] Audit reason update failed for key=${key}:`, e)
      }
    }
  }

  // 9. Invalidar caché Redis (antes de retornar)
  try {
    const client = getConfigRedisClient()
    if (client) {
      await client.del(`config:scoring:${WORKSPACE}`)
    }
  } catch (e) {
    console.warn('[/api/settings/scoring PATCH] Redis invalidation failed:', e)
  }

  // Retornar config actualizada desde DB
  const updatedRows = await query<{ key: string; value: number }>(
    `SELECT key, value::float AS value FROM scoring_config WHERE workspace_id = $1`,
    [WORKSPACE],
  ).catch(() => [] as { key: string; value: number }[])

  const updatedConfig: Record<string, number> = {}
  for (const row of updatedRows) {
    updatedConfig[row.key] = row.value
  }

  return NextResponse.json({
    ok: true,
    config: updatedConfig,
    affected_contacts: affectedContacts,
    impact_note: impactNote,
  })
}
