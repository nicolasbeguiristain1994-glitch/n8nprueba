export type AgentLine = {
  id: string; agent_code: string; linea: number; variant: string; label: string
  phone: string; is_active: boolean; updated_at: string
}
export type AgentDirectoryEntry = { code: string; name: string; lines: AgentLine[] }
export type AssignedContactLine = Pick<AgentLine, 'label' | 'phone'>
export function contactLineLabel(linea?: number | null, variant?: string | null): string {
  return linea == null ? 'Sin línea' : `Línea ${linea}${(variant || '').trim().toUpperCase()}`
}
export function assignedLineMessage(line: AssignedContactLine): string {
  return `Tu línea designada es ${line.label}: ${line.phone}`
}
