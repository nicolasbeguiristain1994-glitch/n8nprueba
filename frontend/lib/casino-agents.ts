/**
 * Agentes operativos visibles en el dashboard de casino.
 * adminbet y surmar son agentes internos/de capital — se excluyen de todas
 * las vistas del dashboard para no distorsionar métricas de operación.
 */
export const AGENTES_PERMITIDOS = ['bigwin', 'ofizeus', 'betcoin', 'royal', 'farabet', 'lasvegas'] as const

/** Literal SQL para filtrar por agentes permitidos en queries de Postgres. */
export const AGENTES_SQL_ARRAY = `'{bigwin,ofizeus,betcoin,royal,farabet,lasvegas}'::text[]`

// ── Multi-platform support ────────────────────────────────────────────────────

export const PLATFORMS = ['zeus', 'bet30', 'ganamos', 'argenbet', 'consolidado'] as const
export type Platform = typeof PLATFORMS[number]

/**
 * Las 4 plataformas que efectivamente sincronizan datos (todo `PLATFORMS`
 * menos `'consolidado'`, que es una vista agregada, no una plataforma real).
 * Única fuente de verdad para "consolidado = todas las plataformas": usada acá
 * mismo (getPlatformFilterSql) y en frontend/components/dashboard/Dashboard.tsx
 * (botón de sync manual). Antes había dos listas hardcodeadas de 2 elementos
 * (`IN ('zeus','bet30')` acá, `['zeus','bet30']` en Dashboard.tsx) que
 * quedaban desactualizadas cada vez que se sumaba una plataforma — exactamente
 * el bug H5 (revisión del coordinador, 2026-09-21).
 */
export const SYNC_PLATFORMS = ['zeus', 'bet30', 'ganamos', 'argenbet'] as const
export type SyncPlatform = typeof SYNC_PLATFORMS[number]

/**
 * Agentes por plataforma — ÚNICA fuente de verdad (H5): 'consolidado' se deriva
 * de las demás entradas más abajo, nunca se lista a mano.
 *
 * ganamos/argenbet: nombres y universo confirmados en
 * docs/PLAN-METRICAS-4-PLATAFORMAS.md (tabla H10 para argenbet — 3 agentes,
 * nivel 2 del árbol bajo "peaky" — y "Universo de agentes" para ganamos — 6
 * agentes). Los nombres van literales, sin "corregir" mayúsculas/prefijos: el
 * panel de cada plataforma los usa exactamente así. Ninguno de los dos tiene
 * conector implementado todavía (fase 2/3) — estas listas solo alimentan el
 * selector del dashboard y el modelo de credenciales de
 * /api/dashboard/casino/sync (H4).
 */
const PLATFORM_AGENTS_BASE: Record<Exclude<Platform, 'consolidado'>, string[]> = {
  zeus:     ['bigwin', 'ofizeus', 'betcoin', 'royal', 'farabet', 'imperio', 'lasvegas'],
  bet30:    ['bigwin', 'zeus', 'zeusroyal', 'btcuno', 'btcdos', 'imperio'],
  // adminbtc→betcoin, adminzeus→ofizeus, adminroyal→royal, admbigwin→bigwin,
  // adminfara→farabet, adminimperio→imperio (mapeo a operador canónico, plan §8.2)
  ganamos:  ['adminbtc', 'adminzeus', 'adminroyal', 'admbigwin', 'adminfara', 'adminimperio'],
  // Nivel 2 del árbol bajo "peaky" — únicos 3 agentes que operan jugadores (D7/H10).
  // adminbtc→betcoin, adminzeus→ofizeus, adminroyal→royal.
  argenbet: ['adminbtc', 'adminzeus', 'adminroyal'],
}

const PLATFORM_AGENTS: Record<Platform, string[]> = {
  ...PLATFORM_AGENTS_BASE,
  consolidado: [...new Set(Object.values(PLATFORM_AGENTS_BASE).flat())],
}

/**
 * Mapeo de nombres de agente crudos (como vienen de cada plataforma) → nombre
 * de operador canónico (el que usa Zeus). Se usa para agrupar métricas
 * consolidadas por operador real, sin importar en qué plataforma operó.
 *
 * Operadores (coincide con casino_contact_account_links, migración 127):
 *   bet30:    btcuno→betcoin, btcdos→farabet, zeus→ofizeus, zeusroyal→royal
 *             (bigwin ya se llama igual en zeus y bet30 — sin mapeo)
 *   argenbet: adminbtc→betcoin, adminzeus→ofizeus, adminroyal→royal (D7/H10)
 *   ganamos:  adminbtc→betcoin, adminzeus→ofizeus, adminroyal→royal,
 *             admbigwin→bigwin, adminfara→farabet, adminimperio→imperio
 *             ('imperio' es su PROPIO operador — no es un alias de 'bigwin';
 *             la migración 126 lo mapeaba mal a 'bigwin' en
 *             casino_contact_account_links, corregido en la 127)
 *
 * NOTA: esta tabla mapea por NOMBRE de agente, sin importar la plataforma de
 * origen — es correcta porque 'adminbtc' significa "betcoin" tanto en ganamos
 * como en argenbet. No mapea los históricos ambiguos (bigwin) porque esos ya
 * son nombres canónicos en sí mismos.
 */
export const AGENT_TO_CANONICAL: Record<string, string> = {
  // bet30
  btcuno:    'betcoin',
  btcdos:    'farabet',
  zeus:      'ofizeus',
  zeusroyal: 'royal',
  // argenbet + ganamos (comparten estos 3 nombres)
  adminbtc:   'betcoin',
  adminzeus:  'ofizeus',
  adminroyal: 'royal',
  // ganamos-only
  admbigwin:    'bigwin',
  adminfara:    'farabet',
  amdfarabet:   'farabet', // alias histórico; no se sincroniza esta cuenta
  adminimperio: 'imperio',
}

/**
 * Devuelve una expresión SQL CASE que normaliza nombres de agente crudos a su
 * nombre de operador canónico. Para usar en GROUP BY de vistas consolidadas.
 */
export function getCanonicalAgenteExpr(col = 'agente'): string {
  const cases = Object.entries(AGENT_TO_CANONICAL)
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
export function isValidSyncPlatform(p: unknown): p is 'zeus' | 'bet30' | 'ganamos' | 'argenbet' {
  return p === 'zeus' || p === 'bet30' || p === 'ganamos' || p === 'argenbet'
}

/**
 * Devuelve la lista de nombres de agentes visibles para una plataforma.
 * H5 fix: antes esta función tenía su propia lista hardcodeada de
 * 'consolidado' (6 agentes de zeus) mientras PLATFORM_AGENTS.consolidado
 * (arriba) listaba 15 — dos fuentes de verdad que podían divergir. Ahora
 * ambas leen de PLATFORM_AGENTS_BASE.
 */
export function getAgentsForPlatform(platform: Platform): string[] {
  return PLATFORM_AGENTS[platform] ?? []
}

/**
 * Fragmento SQL booleano que filtra filas de casino_players o
 * casino_transactions por plataforma. H3 fix: antes el dashboard usaba
 * `agente = ANY(lista_de_agentes)` como proxy de plataforma, lo que mezclaba
 * plataformas cuando un mismo nombre de agente existe en más de una (p.ej.
 * 'bigwin' en zeus y bet30, 'adminbtc' en ganamos y argenbet).
 *
 * Filtra ESTRICTAMENTE por la columna `platform` — sin fallback a lista de
 * agentes. Una primera versión de este helper caía a
 * `OR (platform IS NULL AND agente = ANY(lista))` para no "esconder" filas
 * legacy sin backfillear, pero eso reintroducía exactamente el bug que
 * H3 pide arreglar: un jugador `bigwin` con platform NULL (ambiguo a
 * propósito, ver migración 127) volvía a aparecer en las métricas de Zeus Y
 * de Bet30 a la vez. Los históricos ambiguos quedan fuera de toda vista por
 * plataforma — se reportan aparte (migración 127, RAISE NOTICE +
 * documentación en el runbook), nunca se les asigna una plataforma por
 * adivinanza aunque sea "solo para mostrar".
 *
 * `alias` es el alias de tabla en la query (p.ej. 'cp' para casino_players).
 */
export function getPlatformFilterSql(platform: Platform, alias = ''): string {
  const col = (name: string) => (alias ? `${alias}.${name}` : name)
  if (platform === 'consolidado') {
    return `${col('platform')} = ANY('{${SYNC_PLATFORMS.join(',')}}'::text[])`
  }
  return `${col('platform')} = '${platform}'`
}

/** Compatibility for existing production consumers. */
export const BET30_TO_CANONICAL = { btcuno: "betcoin", btcdos: "farabet", zeus: "ofizeus", zeusroyal: "royal" }
