import { AGENT_TO_CANONICAL, getAgentsForPlatform, type Platform, type SyncPlatform } from './casino-agents'

export const DASHBOARD_TIMEZONE = 'America/Argentina/Buenos_Aires'

// Equivalences are scoped by the movement's explicit platform, never inferred
// from an agent name shared by two platforms.
const ALIASES: Record<SyncPlatform, Record<string, string>> = {
  zeus: {},
  bet30: { btcuno: 'betcoin', btcdos: 'farabet', zeus: 'ofizeus', zeusroyal: 'royal' },
  ganamos: { adminbtc: 'betcoin', adminzeus: 'ofizeus', adminroyal: 'royal', admbigwin: 'bigwin', adminfara: 'farabet', amdfarabet: 'farabet', admfarabet: 'farabet', adminimperio: 'imperio' },
  argenbet: { adminbtc: 'betcoin', adminzeus: 'ofizeus', adminroyal: 'royal' },
}

export function dashboardAgents(platform: Platform): string[] {
  const agents = getAgentsForPlatform(platform)
  return platform === 'consolidado'
    ? [...new Set(agents.map(a => AGENT_TO_CANONICAL[a] ?? a))]
    : agents
}

export function dashboardAgent(platform: Platform, value: string): string {
  const name = value.trim().toLowerCase()
  if (platform === 'consolidado') return AGENT_TO_CANONICAL[name] ?? (name === 'admfarabet' ? 'farabet' : name)
  return name
}

/** Operator of a raw agent observed on an explicit platform, as the consolidated SQL groups it. */
export function platformCanonicalAgent(platform: SyncPlatform, value: string): string {
  const name = value.trim().toLowerCase()
  return ALIASES[platform][name] ?? name
}

/** Configured accounts of `platform` covered by the selected agent; all of them when no agent is selected. */
export function configuredAgentAccounts(scope: Platform, platform: SyncPlatform, agent: string): string[] {
  const agents = getAgentsForPlatform(platform)
  if (!agent) return agents
  return agents.filter(name => scope === 'consolidado' ? platformCanonicalAgent(platform, name) === agent : name === agent)
}

export function normalizedSavedFilters(platform: unknown, agent: unknown): { platform: Platform; agent: string } {
  const valid = ['consolidado', 'zeus', 'bet30', 'ganamos', 'argenbet'].includes(String(platform))
  const p = (valid ? platform : 'consolidado') as Platform
  const a = typeof agent === 'string' ? dashboardAgent(p, agent) : ''
  return { platform: p, agent: dashboardAgents(p).includes(a) ? a : '' }
}

export function platformCanonicalAgentSql(alias = ''): string {
  const col = (name: string) => alias ? `${alias}.${name}` : name
  const name = `LOWER(BTRIM(${col('agente')}))`
  const cases = Object.entries(ALIASES).flatMap(([p, aliases]) => Object.entries(aliases)
    .map(([raw, canonical]) => `WHEN ${col('platform')} = '${p}' AND ${name} = '${raw}' THEN '${canonical}'`))
  return `CASE ${cases.join(' ')} ELSE ${name} END`
}

export function dashboardAgentSql(platform: Platform, param: number, alias = ''): string {
  const col = alias ? `${alias}.agente` : 'agente'
  const name = `LOWER(BTRIM(${col}))`
  if (platform !== 'consolidado') return `($${param}::text IS NULL OR ${name} = $${param})`
  // Resolve the selected operator's aliases once, from the parameter. Mapping
  // every movement's agent through the canonical CASE repeated LOWER/BTRIM for
  // every possible alias, even when a monthly view needed only one operator.
  const cases = Object.entries(ALIASES).filter(([, aliases]) => Object.keys(aliases).length).map(([p, aliases]) => {
    const names = [...new Set([...Object.keys(aliases), ...Object.values(aliases)])]
    const choices = names.map(canonical => {
      const raw = Object.entries(aliases).filter(([, target]) => target === canonical).map(([source]) => source)
      if (!aliases[canonical]) raw.push(canonical)
      return `WHEN '${canonical}' THEN ARRAY[${raw.map(value => `'${value}'`).join(',')}]::text[]`
    })
    return `WHEN '${p}' THEN CASE $${param} ${choices.join(' ')} ELSE ARRAY[$${param}] END`
  })
  const platformCol = alias ? `${alias}.platform` : 'platform'
  return `($${param}::text IS NULL OR ${name} = ANY(CASE ${platformCol} ${cases.join(' ')} ELSE ARRAY[$${param}] END))`
}

/** Calendar date for date-only records; timestamps always converted to Argentina. */
export function movementDateSql(alias = ''): string {
  const col = (name: string) => alias ? `${alias}.${name}` : name
  return `COALESCE((${col('fecha_hora_utc')} AT TIME ZONE '${DASHBOARD_TIMEZONE}')::date, ${col('fecha')})`
}

/** Same Argentina calendar range as movementDateSql, using the native date
 * and timestamp indexes instead of converting every row in the full history. */
export function movementPeriodSql(alias: string, from = '$1::date', to = '$2::date'): string {
  const col = (name: string) => alias ? `${alias}.${name}` : name
  return `((${col('fecha_hora_utc')} IS NOT NULL
    AND ${col('fecha_hora_utc')} >= ((${from})::timestamp AT TIME ZONE '${DASHBOARD_TIMEZONE}')
    AND ${col('fecha_hora_utc')} < (((${to}) + 1)::timestamp AT TIME ZONE '${DASHBOARD_TIMEZONE}'))
    OR (${col('fecha_hora_utc')} IS NULL AND ${col('fecha')} BETWEEN (${from}) AND (${to})))`
}

export function agentScopeLabel(platform: Platform, agent: string): string {
  if (!agent) return 'Todos los agentes'
  if (platform !== 'consolidado') return agent
  const scopes = (Object.keys(ALIASES) as SyncPlatform[]).flatMap(p => {
    const matches = configuredAgentAccounts(platform, p, agent)
    return matches.length ? [`${p}: ${matches.join(', ')}`] : []
  })
  return `${agent} · ${scopes.join(' · ')}`
}
