import { agentScope } from './agent-scope'
import { dashboardAgent, dashboardAgents, platformCanonicalAgent } from './dashboard-scope'
import type { Platform } from './casino-agents'
type Actor = { role: string; allowed_agents?: string[] | null }

export function accessibleDashboardAgents(user: Actor, platform: Platform): string[] {
  const grants = agentScope(user)
  return dashboardAgents(platform).filter(a => grants === null || grants.includes(
    platform === 'consolidado' ? a : platformCanonicalAgent(platform, a)))
}

/** Empty selection defaults to one authorized agent, never the global snapshot. */
export function authorizedDashboardAgent(user: Actor, platform: Platform, requested: string | null):
  { ok: true; agent: string | null } | { ok: false } {
  const agent = dashboardAgent(platform, requested || '') || null
  if (agentScope(user) === null) return { ok: true, agent }
  const allowed = accessibleDashboardAgents(user, platform)
  if (agent && !allowed.includes(agent)) return { ok: false }
  return allowed.length ? { ok: true, agent: agent || allowed[0] } : { ok: false }
}
