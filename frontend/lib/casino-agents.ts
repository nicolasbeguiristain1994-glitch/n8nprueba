/**
 * Agentes operativos visibles en el dashboard de casino.
 * adminbet y surmar son agentes internos/de capital — se excluyen de todas
 * las vistas del dashboard para no distorsionar métricas de operación.
 */
export const AGENTES_PERMITIDOS = ['bigwin', 'ofizeus', 'betcoin', 'royal', 'farabet'] as const

/** Literal SQL para filtrar por agentes permitidos en queries de Postgres. */
export const AGENTES_SQL_ARRAY = `'{bigwin,ofizeus,betcoin,royal,farabet}'::text[]`
