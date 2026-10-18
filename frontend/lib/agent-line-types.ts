export type AgentDeliveryMode = 'phone' | 'link'
export type AgentLine = {
  id: string; agent_code: string; linea: number; variant: string; label: string
  phone: string | null; link_url?: string | null; is_active: boolean; updated_at: string
}
export type AgentDirectoryEntry = { code: string; name: string; delivery_mode?: AgentDeliveryMode; lines: AgentLine[] }
export type AssignedContactLine = Pick<AgentLine, 'label' | 'phone' | 'link_url'> & { delivery_mode?: AgentDeliveryMode }
export function contactLineLabel(linea?: number | null, _legacyVariant?: string | null): string {
  return linea == null ? 'Sin línea' : `Línea ${linea}`
}
export function formatAgentLinePhone(phone?: string | null): string {
  const digits = (phone || '').replace(/^\+/, '')
  return /^549\d{10}$/.test(digits)
    ? `${digits.slice(0,3)} | ${digits.slice(3,7)} | ${digits.slice(7)}`
    : phone || ''
}
export function validAgentLink(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false
  if (!value || value.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(value)) return false
  try {
    const url = new URL(value)
    return /^https?:$/.test(url.protocol) && !!url.hostname && !url.username && !url.password
  } catch { return false }
}
export function assignedLineDestination(line: AssignedContactLine): string | null {
  if (line.delivery_mode === 'link') return line.link_url && validAgentLink(line.link_url) ? line.link_url : null
  return line.phone ? formatAgentLinePhone(line.phone) : null
}
export function assignedLineMessage(line: AssignedContactLine): string {
  const destination = assignedLineDestination(line)
  return destination ? `Tu línea designada es ${line.label}: ${destination}` : ''
}
