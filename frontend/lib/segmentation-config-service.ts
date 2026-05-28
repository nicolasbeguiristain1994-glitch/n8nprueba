import { query } from '@/lib/db'
import {
  VALUE_SCORES,
  INACTIVITY_WINDOWS,
  RECONTACT_COOLDOWN_DAYS,
  DEPOSIT_AMOUNT_TIERS,
} from '@/lib/user-prioritization/config'
import { getConfigRedisClient } from '@/lib/redis'

export type TierName = 'vip' | 'alto' | 'medio' | 'bajo'

export interface SegmentationTier {
  tier: TierName
  min_days_inactive: number
  max_days_inactive: number
  value_score: number
  deposit_threshold_min: number
  recontact_cooldown_days: number
  is_active: boolean
  workspace_id: string
  updated_by: string | null
  updated_at: string
}

type DataSource = 'cache' | 'db' | 'fallback'

interface TiersResult {
  tiers: SegmentationTier[]
  source: DataSource
}

const CACHE_TTL_SECONDS = 300

// Orden de prioridad para resolución de solapamientos entre ventanas de inactividad.
// VIP/ALTO comparten minDays=7 → vip toma precedencia sobre alto, etc.
const TIER_PRIORITY: TierName[] = ['vip', 'alto', 'medio', 'bajo']

// ── Fallback hardcodeado ──────────────────────────────────────────────────────
//
// Solo se usa si tanto Redis como DB lanzan excepción (degradación grave).
// Importa valores de config.ts — si config.ts cambia, este fallback cambia.
// NUNCA duplicar los números inline aquí.
//
// NOTA para cuando se implemente PATCH: al guardar cambios en segmentation_tiers,
// invalidar las siguientes Redis keys del workspace:
//   DEL config:segmentation:{workspaceId}:all
//   DEL config:segmentation:{workspaceId}:vip
//   DEL config:segmentation:{workspaceId}:alto
//   DEL config:segmentation:{workspaceId}:medio
//   DEL config:segmentation:{workspaceId}:bajo
// O usar SCAN + DEL con patrón "config:segmentation:{workspaceId}:*"

function buildFallbackTiers(): SegmentationTier[] {
  return TIER_PRIORITY.map(tier => ({
    tier,
    min_days_inactive:       INACTIVITY_WINDOWS[tier].minDays,
    max_days_inactive:       INACTIVITY_WINDOWS[tier].maxDays,
    value_score:             VALUE_SCORES[tier],
    deposit_threshold_min:   DEPOSIT_AMOUNT_TIERS.find(d => d.tier === tier)!.minAmount,
    recontact_cooldown_days: RECONTACT_COOLDOWN_DAYS[tier],
    is_active:               true,
    workspace_id:            'default',
    updated_by:              null,
    updated_at:              new Date(0).toISOString(),
  }))
}

// ── Validaciones (reutilizadas en endpoint PATCH futuro) ──────────────────────

export function validateTierConfig(tier: Partial<SegmentationTier>): string[] {
  const errors: string[] = []

  if (tier.min_days_inactive !== undefined && tier.min_days_inactive < 0)
    errors.push('min_days_inactive debe ser >= 0')

  if (
    tier.min_days_inactive !== undefined &&
    tier.max_days_inactive !== undefined &&
    tier.max_days_inactive <= tier.min_days_inactive
  )
    errors.push('max_days_inactive debe ser > min_days_inactive')

  if (
    tier.value_score !== undefined &&
    (tier.value_score < 0 || tier.value_score > 100)
  )
    errors.push('value_score debe estar entre 0 y 100 (inclusive)')

  if (tier.deposit_threshold_min !== undefined && tier.deposit_threshold_min < 0)
    errors.push('deposit_threshold_min debe ser >= 0')

  if (tier.recontact_cooldown_days !== undefined && tier.recontact_cooldown_days < 1)
    errors.push('recontact_cooldown_days debe ser >= 1')

  return errors
}

// ── Helpers Redis ─────────────────────────────────────────────────────────────

const REDIS_OP_TIMEOUT_MS = 500

async function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), REDIS_OP_TIMEOUT_MS)),
  ])
}

async function redisGet(key: string): Promise<string | null> {
  try {
    const client = getConfigRedisClient()
    if (!client) return null
    return await withTimeout(client.get(key), null)
  } catch (err) {
    console.warn('[segmentation-config] Redis GET error:', err)
    return null
  }
}

async function redisSet(key: string, value: string): Promise<void> {
  try {
    const client = getConfigRedisClient()
    if (!client) return
    await client.setEx(key, CACHE_TTL_SECONDS, value)
  } catch (err) {
    console.warn('[segmentation-config] Redis SET error:', err)
  }
}

function allCacheKey(workspaceId: string) {
  return `config:segmentation:${workspaceId}:all`
}

function tierCacheKey(workspaceId: string, tier: TierName) {
  return `config:segmentation:${workspaceId}:${tier}`
}

// ── Query DB ──────────────────────────────────────────────────────────────────

async function queryAllFromDB(workspaceId: string): Promise<SegmentationTier[]> {
  return query<SegmentationTier>(
    `SELECT tier, min_days_inactive, max_days_inactive, value_score,
            deposit_threshold_min, recontact_cooldown_days, is_active,
            workspace_id, updated_by::text AS updated_by, updated_at::text AS updated_at
     FROM segmentation_tiers
     WHERE workspace_id = $1 AND is_active = true
     ORDER BY value_score DESC`,
    [workspaceId],
  )
}

// ── Implementación interna con source tracking ────────────────────────────────

async function getAllTiersInternal(workspaceId: string): Promise<TiersResult> {
  const cacheKey = allCacheKey(workspaceId)

  const cached = await redisGet(cacheKey)
  if (cached) {
    return { tiers: JSON.parse(cached) as SegmentationTier[], source: 'cache' }
  }

  try {
    const rows = await queryAllFromDB(workspaceId)
    void redisSet(cacheKey, JSON.stringify(rows))
    return { tiers: rows, source: 'db' }
  } catch (err) {
    console.error(
      '[segmentation-config] DB y Redis fallaron — usando fallback hardcodeado. ' +
      'DEGRADACIÓN GRAVE del sistema.',
      err,
    )
    return { tiers: buildFallbackTiers(), source: 'fallback' }
  }
}

// ── API pública ───────────────────────────────────────────────────────────────

export async function getAllTiers(workspaceId = 'default'): Promise<SegmentationTier[]> {
  return (await getAllTiersInternal(workspaceId)).tiers
}

/** Variante que incluye la fuente de datos. Usada por el endpoint GET para debugging. */
export async function getAllTiersWithSource(workspaceId = 'default'): Promise<TiersResult> {
  return getAllTiersInternal(workspaceId)
}

export async function getTierConfig(
  tier: TierName,
  workspaceId = 'default',
): Promise<SegmentationTier> {
  const cacheKey = tierCacheKey(workspaceId, tier)

  const cached = await redisGet(cacheKey)
  if (cached) return JSON.parse(cached) as SegmentationTier

  try {
    const rows = await query<SegmentationTier>(
      `SELECT tier, min_days_inactive, max_days_inactive, value_score,
              deposit_threshold_min, recontact_cooldown_days, is_active,
              workspace_id, updated_by::text AS updated_by, updated_at::text AS updated_at
       FROM segmentation_tiers
       WHERE tier = $1 AND workspace_id = $2 AND is_active = true`,
      [tier, workspaceId],
    )
    if (rows[0]) {
      void redisSet(cacheKey, JSON.stringify(rows[0]))
      return rows[0]
    }
    return buildFallbackTiers().find(t => t.tier === tier)!
  } catch (err) {
    console.error(
      `[segmentation-config] DB y Redis fallaron para tier=${tier} — usando fallback. DEGRADACIÓN GRAVE.`,
      err,
    )
    return buildFallbackTiers().find(t => t.tier === tier)!
  }
}

/**
 * Retorna el tier cuya ventana [min_days_inactive, max_days_inactive] contiene `days`.
 * Si `days` cae en múltiples ventanas (vip y alto comparten minDays=7),
 * prioriza: vip > alto > medio > bajo.
 * Retorna null si `days` no cae en ninguna ventana activa.
 */
export async function getTierByDaysInactive(
  days: number,
  workspaceId = 'default',
): Promise<SegmentationTier | null> {
  const tiers = await getAllTiers(workspaceId)

  for (const name of TIER_PRIORITY) {
    const t = tiers.find(r => r.tier === name)
    if (t && days >= t.min_days_inactive && days <= t.max_days_inactive) {
      return t
    }
  }

  return null
}
