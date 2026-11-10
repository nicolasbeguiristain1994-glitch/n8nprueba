import { agentScope, canonicalAgent } from './agent-scope'

// Shared by contact selectors and the contact update validator.
export const CONTACT_AGENT_OPTIONS = ['betcoin', 'bigwin', 'farabet', 'ofizeus', 'royal', 'lasvegas', 'elduende'] as const
export function contactAgentLabel(agent: string): string {
  return agent === 'elduende' ? 'El Duende' : agent
}

type Actor = { role: string; allowed_agents?: string[] | null }

/** No directory names are exposed while the current profile is loading. */
export function visibleAgentOptions(user: Actor | null | undefined, defaults: readonly string[]): string[] {
  return user ? agentScope(user) ?? [...defaults] : []
}

/** Recheck saved selections when grants change, before rendering or fetching. */
export function visibleAgentSelection(user: Actor | null | undefined, value: string, empty = ''): string {
  if (!user) return empty
  const scope = agentScope(user)
  if (scope === null) return value
  const agent = canonicalAgent(value)
  return scope.includes(agent) ? agent : empty
}
