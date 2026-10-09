export type AgentLine = {
  id: string; agent_code: string; linea: number; variant: string; label: string
  phone: string; is_active: boolean; updated_at: string
}
export type AgentDirectoryEntry = { code: string; name: string; lines: AgentLine[] }
export type AssignedContactLine = Pick<AgentLine, 'label' | 'phone'>
export function contactLineLabel(linea?: number | null, variant?: string | null): string {
  return linea == null ? 'Sin línea' : `Línea ${linea}${(variant || '').trim().toUpperCase()}`
}
export function formatAgentLinePhone(phone: string): string {
  const digits = phone.replace(/^\+/, '')
  return /^549\d{10}$/.test(digits)
    ? `${digits.slice(0,3)} | ${digits.slice(3,7)} | ${digits.slice(7)}`
    : phone
}
export function assignedLineMessage(line: AssignedContactLine): string {
  return `Tu línea designada es ${line.label}: ${formatAgentLinePhone(line.phone)}`
}
