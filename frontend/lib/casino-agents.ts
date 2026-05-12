/**
 * Agentes operativos visibles en el dashboard de casino.
 * adminbet y surmar son agentes internos/de capital — se excluyen de todas
 * las vistas del dashboard para no distorsionar métricas de operación.
 */
export const AGENTES_PERMITIDOS = ['bigwin', 'ofizeus', 'betcoin', 'royal', 'farabet'] as const

/** Literal SQL para filtrar por agentes permitidos en queries de Postgres. */
export const AGENTES_SQL_ARRAY = `'{bigwin,ofizeus,betcoin,royal,farabet}'::text[]`

// ── Multi-platform support ────────────────────────────────────────────────────

export const PLATFORMS = ['zeus', 'bet30'] as const
export type Platform = typeof PLATFORMS[number]

/** Agentes operativos por plataforma. Actualizar al agregar nuevos agentes por plataforma. */
const PLATFORM_AGENTS: Record<Platform, string[]> = {
  zeus:  ['bigwin', 'ofizeus', 'betcoin', 'royal', 'farabet'],
  bet30: [],  // actualizar cuando se sincronice bet30 por primera vez
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
