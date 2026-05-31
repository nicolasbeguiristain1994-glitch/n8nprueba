import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { getAllTiersWithSource, validateTierConfig } from '@/lib/segmentation-config-service'
import type { TierName } from '@/lib/segmentation-config-service'
import { getConfigRedisClient } from '@/lib/redis'

const WORKSPACE = 'default'

const TIER_NAMES: TierName[] = ['super_vip', 'vip', 'medio', 'bajo']

// Campos que el cliente puede modificar. El campo `tier` y metadatos son inmutables.
const ALLOWED_CHANGE_FIELDS = [
  'min_days_inactive',
  'max_days_inactive',
  'value_score',
  'deposit_threshold_min',
  'recontact_cooldown_days',
  'is_active',
] as const
type AllowedField = typeof ALLOWED_CHANGE_FIELDS[number]

// Campos críticos: requieren reason ≥ 10 caracteres en el body
const CRITICAL_FIELDS: AllowedField[] = [
  'min_days_inactive',
  'max_days_inactive',
  'deposit_threshold_min',
]

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'settings', 'read')
  if (!auth.ok) return auth.response

  try {
    const { tiers, source } = await getAllTiersWithSource()
    return NextResponse.json({ tiers, source })
  } catch (e) {
    console.error('[/api/settings/segmentation GET]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── PATCH ─────────────────────────────────────────────────────────────────────

type PatchBody = {
  tier: TierName
  changes: Partial<Record<AllowedField, number | boolean>>
  reason?: string
  updated_at: string
}

export async function PATCH(req: NextRequest) {
  // 1. Auth: solo admins pueden modificar configuración
  const auth = await checkPermissionWithUser(req, 'settings', 'manage')
  if (!auth.ok) return auth.response

  // checkPermissionWithUser con 'manage' ya garantiza admin-only.
  // Verificación explícita como defensa en profundidad.
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

  const { tier, changes, reason, updated_at: clientUpdatedAt } = body

  if (!tier || !TIER_NAMES.includes(tier)) {
    return NextResponse.json({ error: `tier inválido: debe ser uno de ${TIER_NAMES.join(', ')}` }, { status: 400 })
  }
  if (!changes || typeof changes !== 'object' || Object.keys(changes).length === 0) {
    return NextResponse.json({ error: 'changes no puede estar vacío' }, { status: 400 })
  }
  if (!clientUpdatedAt || typeof clientUpdatedAt !== 'string') {
    return NextResponse.json({ error: 'updated_at es requerido para control de concurrencia' }, { status: 400 })
  }

  // Filtrar solo campos permitidos (prevención de mass assignment)
  const sanitizedChanges: Partial<Record<AllowedField, number | boolean>> = {}
  for (const [key, val] of Object.entries(changes)) {
    if ((ALLOWED_CHANGE_FIELDS as readonly string[]).includes(key)) {
      sanitizedChanges[key as AllowedField] = val as number | boolean
    }
  }
  if (Object.keys(sanitizedChanges).length === 0) {
    return NextResponse.json({ error: 'Ningún campo válido en changes' }, { status: 400 })
  }

  // 3. Validar rangos con la función del servicio
  const validationErrors = validateTierConfig(sanitizedChanges as Parameters<typeof validateTierConfig>[0])
  if (validationErrors.length > 0) {
    return NextResponse.json({ error: 'Validación fallida', errors: validationErrors }, { status: 400 })
  }

  // 4. Verificar reason para campos críticos
  const hasCriticalChange = CRITICAL_FIELDS.some(f => f in sanitizedChanges)
  if (hasCriticalChange && (!reason || reason.trim().length < 10)) {
    return NextResponse.json({
      error: 'Los campos min_days_inactive, max_days_inactive y deposit_threshold_min requieren un motivo de al menos 10 caracteres',
    }, { status: 400 })
  }

  // 5. Concurrencia optimista: verificar updated_at actual en DB
  let currentRow: {
    tier: TierName
    min_days_inactive: number
    max_days_inactive: number
    deposit_threshold_min: number
    updated_at: string
  } | undefined

  try {
    const rows = await query<typeof currentRow & Record<string, unknown>>(
      `SELECT tier, min_days_inactive, max_days_inactive, deposit_threshold_min,
              updated_at::text AS updated_at
       FROM segmentation_tiers
       WHERE tier = $1 AND workspace_id = $2`,
      [tier, WORKSPACE],
    )
    currentRow = rows[0] as typeof currentRow
  } catch (e) {
    console.error('[/api/settings/segmentation PATCH] DB fetch error', e)
    return NextResponse.json({ error: 'Error al verificar estado actual' }, { status: 500 })
  }

  if (!currentRow) {
    return NextResponse.json({ error: `Tier ${tier} no encontrado` }, { status: 404 })
  }

  // Comparar timestamps (normalizar a ms para evitar diferencias de formato)
  const dbTs     = new Date(currentRow.updated_at).getTime()
  const clientTs = new Date(clientUpdatedAt).getTime()
  if (dbTs !== clientTs) {
    return NextResponse.json({
      error: 'El registro fue modificado por otro usuario. Refrescá la página.',
    }, { status: 409 })
  }

  // 6. Simulación de impacto (solo si min_days/max_days cambian)
  let affectedContacts = 0
  const newMinDays = 'min_days_inactive' in sanitizedChanges
    ? sanitizedChanges.min_days_inactive as number
    : currentRow.min_days_inactive
  const newMaxDays = 'max_days_inactive' in sanitizedChanges
    ? sanitizedChanges.max_days_inactive as number
    : currentRow.max_days_inactive

  if ('min_days_inactive' in sanitizedChanges || 'max_days_inactive' in sanitizedChanges) {
    try {
      const affectedRows = await query<{ affected: number }>(
        `SELECT COUNT(*)::int AS affected
         FROM contact_priority_scores
         WHERE value_tier = $1
           AND (days_inactive < $2 OR days_inactive > $3)`,
        [tier, newMinDays, newMaxDays],
      )
      affectedContacts = affectedRows[0]?.affected ?? 0
    } catch (e) {
      // No bloquear el PATCH si la simulación falla (tabla puede no tener datos aún)
      console.warn('[/api/settings/segmentation PATCH] Impact simulation failed:', e)
      affectedContacts = -1
    }
  }

  // 7. UPDATE en segmentation_tiers (el trigger escribe en settings_audit_log)
  const entries = Object.entries(sanitizedChanges) as [AllowedField, number | boolean][]
  const values: unknown[] = entries.map(([, v]) => v)
  const setClauses = entries.map(([field], i) => `${field} = $${i + 1}`)
  setClauses.push(`updated_by = $${entries.length + 1}`)
  setClauses.push('updated_at = NOW()')
  values.push(auth.user.user_id, tier, WORKSPACE)

  const tierParamIdx = entries.length + 2
  const wsParamIdx   = entries.length + 3

  let updatedRow: Record<string, unknown> | undefined
  try {
    const updatedRows = await query<Record<string, unknown>>(
      `UPDATE segmentation_tiers
       SET ${setClauses.join(', ')}
       WHERE tier = $${tierParamIdx} AND workspace_id = $${wsParamIdx}
       RETURNING tier, min_days_inactive, max_days_inactive, value_score,
                 deposit_threshold_min, recontact_cooldown_days, is_active,
                 workspace_id, updated_by::text AS updated_by, updated_at::text AS updated_at`,
      values,
    )
    updatedRow = updatedRows[0]
  } catch (e) {
    console.error('[/api/settings/segmentation PATCH] UPDATE error', e)
    return NextResponse.json({ error: 'Error al guardar los cambios' }, { status: 500 })
  }

  // 8. Enriquecer audit log con reason si está presente.
  //    El trigger ya insertó la fila; este UPDATE agrega el motivo.
  //    settings_audit_log es append-only, pero se permite este enriquecimiento
  //    post-trigger para asociar el reason del request al registro de auditoría.
  if (reason?.trim()) {
    try {
      await query(
        `UPDATE settings_audit_log
         SET reason = $1
         WHERE id = (
           SELECT id FROM settings_audit_log
           WHERE table_name = 'segmentation_tiers'
             AND record_id = $2
             AND operation = 'UPDATE'
           ORDER BY changed_at DESC
           LIMIT 1
         )`,
        [reason.trim(), `${tier}:${WORKSPACE}`],
      )
    } catch (e) {
      // No bloquear el response si el enriquecimiento de audit falla
      console.warn('[/api/settings/segmentation PATCH] Audit reason update failed:', e)
    }
  }

  // 9. Invalidar caché Redis (antes de retornar)
  try {
    const client = getConfigRedisClient()
    if (client) {
      await client.del([
        `config:segmentation:${WORKSPACE}:all`,
        `config:segmentation:${WORKSPACE}:vip`,
        `config:segmentation:${WORKSPACE}:alto`,
        `config:segmentation:${WORKSPACE}:medio`,
        `config:segmentation:${WORKSPACE}:bajo`,
      ])
    }
  } catch (e) {
    console.warn('[/api/settings/segmentation PATCH] Redis invalidation failed:', e)
  }

  return NextResponse.json({ ok: true, tier: updatedRow, affected_contacts: affectedContacts })
}
