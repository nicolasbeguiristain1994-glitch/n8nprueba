import { query } from '@/lib/db'
import {
  ALLOW_THRESHOLD,
  DELAY_THRESHOLD,
  COOLDOWN_PROPORTIONAL_MULTIPLIER,
  RISK_WEIGHTS,
} from '@/lib/contact-frequency/rules'
import { getConfigRedisClient } from '@/lib/redis'

// urgency_score_max = 40: este valor aparece como literal `* 40` en
// scoring.ts:scoreUrgency() y no está exportado desde rules.ts ni config.ts.
// Es el único valor del fallback que no puede importarse de los archivos fuente.
// Si se mueve a una constante exportada en scoring.ts en el futuro, reemplazar aquí.
const URGENCY_SCORE_MAX_FALLBACK = 40

// Union tipado de las 7 keys válidas. Previene typos en compile time.
export type ScoringConfigKey =
  | 'urgency_score_max'
  | 'risk_weight_daily'
  | 'risk_weight_weekly'
  | 'risk_weight_cooldown'
  | 'allow_threshold'
  | 'delay_threshold'
  | 'cooldown_multiplier'

type DataSource = 'cache' | 'db' | 'fallback'

interface ScoringResult {
  config: Record<ScoringConfigKey, number>
  source: DataSource
}

const CACHE_TTL_SECONDS = 300

// ── Fallback hardcodeado ──────────────────────────────────────────────────────
//
// Solo se usa si tanto Redis como DB lanzan excepción (degradación grave).
// Importa de rules.ts — si rules.ts cambia, este fallback cambia automáticamente.
//
// NOTA para cuando se implemente PATCH: al guardar cambios en scoring_config,
// invalidar el cache con:
//   DEL config:scoring:{workspaceId}

const FALLBACK_SCORING: Record<ScoringConfigKey, number> = {
  urgency_score_max:    URGENCY_SCORE_MAX_FALLBACK,
  risk_weight_daily:    RISK_WEIGHTS.daily,
  risk_weight_weekly:   RISK_WEIGHTS.weekly,
  risk_weight_cooldown: RISK_WEIGHTS.cooldown,
  allow_threshold:      ALLOW_THRESHOLD,
  delay_threshold:      DELAY_THRESHOLD,
  cooldown_multiplier:  COOLDOWN_PROPORTIONAL_MULTIPLIER,
}

// ── Validaciones (reutilizadas en endpoint PATCH futuro) ──────────────────────

export function validateScoringConfig(
  config: Partial<Record<ScoringConfigKey, number>>,
): string[] {
  const errors: string[] = []

  if (
    config.urgency_score_max !== undefined &&
    (config.urgency_score_max < 1 || config.urgency_score_max > 100)
  )
    errors.push('urgency_score_max debe estar entre 1 y 100')

  const d = config.risk_weight_daily
  const w = config.risk_weight_weekly
  const c = config.risk_weight_cooldown
  if (d !== undefined && w !== undefined && c !== undefined && d + w + c !== 100)
    errors.push('risk_weight_daily + risk_weight_weekly + risk_weight_cooldown debe sumar 100 exactamente')

  if (config.allow_threshold !== undefined && config.allow_threshold < 0)
    errors.push('allow_threshold debe ser >= 0')

  if (config.delay_threshold !== undefined && config.delay_threshold > 100)
    errors.push('delay_threshold debe ser <= 100')

  if (
    config.allow_threshold !== undefined &&
    config.delay_threshold !== undefined &&
    config.allow_threshold >= config.delay_threshold
  )
    errors.push('allow_threshold debe ser < delay_threshold')

  if (config.cooldown_multiplier !== undefined && config.cooldown_multiplier < 1)
    errors.push('cooldown_multiplier debe ser >= 1')

  return errors
}

// ── Helpers Redis ─────────────────────────────────────────────────────────────

async function redisGet(key: string): Promise<string | null> {
  try {
    const client = getConfigRedisClient()
    if (!client) return null
    return await client.get(key)
  } catch (err) {
    console.warn('[scoring-config] Redis GET error:', err)
    return null
  }
}

async function redisSet(key: string, value: string): Promise<void> {
  try {
    const client = getConfigRedisClient()
    if (!client) return
    await client.setEx(key, CACHE_TTL_SECONDS, value)
  } catch (err) {
    console.warn('[scoring-config] Redis SET error:', err)
  }
}

function cacheKey(workspaceId: string) {
  return `config:scoring:${workspaceId}`
}

// ── Query DB ──────────────────────────────────────────────────────────────────

async function queryAllFromDB(
  workspaceId: string,
): Promise<Record<ScoringConfigKey, number>> {
  const rows = await query<{ key: string; value: string }>(
    `SELECT key, value::text AS value
     FROM scoring_config
     WHERE workspace_id = $1`,
    [workspaceId],
  )

  // Partir del fallback y sobreescribir con valores de DB.
  // Keys desconocidas en DB se ignoran; keys ausentes en DB usan el fallback.
  const result: Record<ScoringConfigKey, number> = { ...FALLBACK_SCORING }
  for (const row of rows) {
    if (row.key in result) {
      ;(result as Record<string, number>)[row.key] = parseFloat(row.value)
    }
  }
  return result
}

// ── Implementación interna con source tracking ────────────────────────────────

async function getAllInternal(workspaceId: string): Promise<ScoringResult> {
  const key = cacheKey(workspaceId)

  const cached = await redisGet(key)
  if (cached) {
    return { config: JSON.parse(cached) as Record<ScoringConfigKey, number>, source: 'cache' }
  }

  try {
    const config = await queryAllFromDB(workspaceId)
    void redisSet(key, JSON.stringify(config))
    return { config, source: 'db' }
  } catch (err) {
    console.error(
      '[scoring-config] DB y Redis fallaron — usando fallback hardcodeado. ' +
      'DEGRADACIÓN GRAVE del sistema.',
      err,
    )
    return { config: { ...FALLBACK_SCORING }, source: 'fallback' }
  }
}

// ── API pública ───────────────────────────────────────────────────────────────

export async function getAll(
  workspaceId = 'default',
): Promise<Record<ScoringConfigKey, number>> {
  return (await getAllInternal(workspaceId)).config
}

/** Variante que incluye la fuente de datos. Usada por el endpoint GET para debugging. */
export async function getAllWithSource(workspaceId = 'default'): Promise<ScoringResult> {
  return getAllInternal(workspaceId)
}

export async function get(
  key: ScoringConfigKey,
  workspaceId = 'default',
): Promise<number> {
  return (await getAll(workspaceId))[key]
}
