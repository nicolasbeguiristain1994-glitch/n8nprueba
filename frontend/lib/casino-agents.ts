/**
 * Agentes operativos visibles en el dashboard de casino.
 * adminbet y surmar son agentes internos/de capital — se excluyen de todas
 * las vistas del dashboard para no distorsionar métricas de operación.
 */
export const AGENTES_PERMITIDOS = ['bigwin', 'ofizeus', 'betcoin', 'royal', 'farabet'] as const

/** Literal SQL para filtrar por agentes permitidos en queries de Postgres. */
export const AGENTES_SQL_ARRAY = `'{bigwin,ofizeus,betcoin,royal,farabet}'::text[]`

// ── Multi-platform support ────────────────────────────────────────────────────

export const PLATFORMS = ['zeus', 'bet30', 'consolidado'] as const
export type Platform = typeof PLATFORMS[number]

/**
 * Agentes por plataforma.
 *
 * 'consolidado' = todos los agentes de zeus + bet30 juntos.
 * Los nombres en bet30 se normalizan al operador canónico via BET30_TO_CANONICAL.
 */
const PLATFORM_AGENTS: Record<Platform, string[]> = {
  zeus:        ['bigwin', 'ofizeus', 'betcoin', 'royal', 'farabet'],
  bet30:       ['bigwin', 'zeus', 'zeusroyal', 'btcuno', 'btcdos'],
  consolidado: ['bigwin', 'ofizeus', 'betcoin', 'royal', 'farabet',
                'zeus', 'zeusroyal', 'btcuno', 'btcdos'],
}

/**
 * Mapeo de nombres de agentes bet30 → nombre canónico (equivalente en zeus).
 * Se usa para agrupar métricas consolidadas por operador real.
 *
 * Operadores:
 *   bigwin    → bigwin    (mismo username en ambas plataformas)
 *   btcuno    → betcoin
 *   btcdos    → farabet
 *   zeus      → ofizeus
 *   zeusroyal → royal
 */
export const BET30_TO_CANONICAL: Record<string, string> = {
  btcuno:    'betcoin',
  btcdos:    'farabet',
  zeus:      'ofizeus',
  zeusroyal: 'royal',
}

/**
 * Devuelve una expresión SQL CASE que normaliza los nombres de agentes bet30
 * a su nombre canónico. Para usar en GROUP BY de vistas consolidadas.
 *
 * Ejemplo de salida:
 *   CASE agente
 *     WHEN 'btcuno'    THEN 'betcoin'
 *     WHEN 'btcdos'    THEN 'farabet'
 *     WHEN 'zeus'      THEN 'ofizeus'
 *     WHEN 'zeusroyal' THEN 'royal'
 *     ELSE agente
 *   END
 */
export function getCanonicalAgenteExpr(col = 'agente'): string {
  const cases = Object.entries(BET30_TO_CANONICAL)
    .map(([from, to]) => `WHEN '${from}' THEN '${to}'`)
    .join('\n        ')
  return `CASE ${col}\n        ${cases}\n        ELSE ${col}\n      END`
}

/** Devuelve el literal SQL `'{ag1,ag2,...}'::text[]` para la plataforma dada. */
export function getAgentsSqlArray(platform: string): string {
  const agents = PLATFORM_AGENTS[platform as Platform] ?? PLATFORM_AGENTS.zeus
  if (!agents.length) return `'{}'::text[]`
  return `'{${agents.join(',')}}'::text[]`
}

export function isValidPlatform(p: unknown): p is Platform {
  return PLATFORMS.includes(p as Platform)
}

/** Solo zeus y bet30 son targets válidos de sync (no 'consolidado'). */
export function isValidSyncPlatform(p: unknown): p is 'zeus' | 'bet30' {
  return p === 'zeus' || p === 'bet30'
}

/**
 * Devuelve la lista de nombres de agentes visibles para una plataforma.
 * Para 'consolidado' devuelve los nombres canónicos (zeus).
 */
export function getAgentsForPlatform(platform: Platform): string[] {
  switch (platform) {
    case 'zeus':        return ['bigwin', 'ofizeus', 'betcoin', 'royal', 'farabet']
    case 'bet30':       return ['bigwin', 'zeus', 'zeusroyal', 'btcuno', 'btcdos']
    case 'consolidado': return ['bigwin', 'ofizeus', 'betcoin', 'royal', 'farabet']
  }
}
