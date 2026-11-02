import { AGENT_TO_CANONICAL } from './casino-agents'

export const AGENT_KEYS = ['betcoin', 'bigwin', 'farabet', 'ofizeus', 'royal', 'lasvegas', 'imperio', 'elduende', '247'] as const
export type AgentKey = typeof AGENT_KEYS[number]
type Actor = { role: string; allowed_agents?: string[] | null }

export function canonicalAgent(value: string): string {
  const key = value.trim().toLowerCase()
  return AGENT_TO_CANONICAL[key] ?? key
}

// Preserve the existing unrestricted profile. A nonempty but invalid grant must
// fail closed, rather than accidentally turning into unrestricted access.
export function agentScope(user: Actor): string[] | null {
  if (user.role === 'admin' || !user.allowed_agents?.length) return null
  return [...new Set(user.allowed_agents.map(canonicalAgent))].filter(a => /^[a-z0-9][a-z0-9_-]{0,99}$/.test(a))
}

export function canAccessAgent(user: Actor, agent: string | null): boolean {
  const scope = agentScope(user)
  return scope === null || (agent !== null && scope.includes(agent))
}

export function campaignScopeSql(alias: string, owner: string, agents: string): string {
  return `((${agents}::text[] IS NOT NULL AND ${alias}.agent_key = ANY(${agents}::text[]))
    OR (${agents}::text[] IS NULL AND (${owner}::uuid IS NULL OR ${alias}.owned_by=${owner})))`
}

export const AGENT_PROFILE_SECTORS = ['conversations', 'estadisticas', 'calendar']
