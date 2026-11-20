export type BlacklistEntry = {
  id: string
  scope_key: string
  agent_code: string | null
  reason: string | null
  line_name: string | null
}

export function blacklistScopeLabel(entry: BlacklistEntry): string {
  if (entry.scope_key === 'global') return 'Todos los agentes y líneas (global)'
  if (entry.agent_code) return `Agente ${entry.agent_code}`
  return `Línea ${entry.line_name || entry.scope_key.replace(/^source:/, '')}`
}
