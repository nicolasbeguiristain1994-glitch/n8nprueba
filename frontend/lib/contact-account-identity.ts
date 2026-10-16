import { AGENT_TO_CANONICAL } from './casino-agents'

export function canonicalContactAgent(value: string | null | undefined): string | null {
  const agent = value?.trim().toLowerCase()
  return agent ? AGENT_TO_CANONICAL[agent] ?? agent : null
}
export function contactAccountKey(agent: string | null, username: string | null, phone: string): string {
  return `[${JSON.stringify(canonicalContactAgent(agent) ?? '')}, ${JSON.stringify(username?.trim().toLowerCase() || `phone:${phone}`)}]`
}
