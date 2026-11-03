import { agentScope, canAccessAgent } from './agent-scope'
import type { SessionUser } from './auth'
type Rule = { type?: unknown; action_config?: unknown }
export function canAccessAutomation(user: Pick<SessionUser,'role'|'allowed_agents'>, rule: Rule): boolean {
  if (user.role === 'admin') return true
  const config = rule.action_config as { contact_line_directory?: unknown } | null
  return agentScope(user) !== null && rule.type === 'reply' && typeof config?.contact_line_directory === 'string'
    && canAccessAgent(user, config.contact_line_directory)
}
/** Rechecked both when scheduling and when sending, using current grants. */
export const AUTOMATION_CREATOR_SQL = `(u.role='admin' OR (u.role='operator' AND u.sectors ? 'automations'
  AND a.type='reply' AND a.action_config->>'contact_line_directory'=ANY(u.allowed_agents)))`
