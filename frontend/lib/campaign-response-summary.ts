export interface ResponseOption { label: string; mensajes: number; personas: number }
export interface CampaignResponseSummary { personas: number; opciones: ResponseOption[] }
export interface ResponseRecord { phone: string | null; candidates: string[]; count: number }

const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleUpperCase('es')
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}

// Only full text or explicit button replies count as an option, never captions
// or sentences that merely mention a keyword. Keep arbitrary text private.
export function responseCandidates(type: string | null, content: unknown): string[] {
  const data = object(content)
  const button = object(data.button)
  const interactive = object(data.interactive)
  const reply = object(interactive.button_reply)
  const values = type === 'text' ? [object(data.text).body]
    : type === 'button' ? [button.payload, button.text]
    : type === 'interactive' && interactive.type === 'button_reply' ? [reply.id, reply.title] : []
  return values.filter((value): value is string => typeof value === 'string' && !!value.trim())
}

export function summarizeResponses(components: unknown, params: unknown, replies: ResponseRecord[]): CampaignResponseSummary {
  const buckets = new Map<string, { label: string; mensajes: number; phones: Set<string> }>()
  const aliases = new Map<string, string>()
  const add = (label: string) => {
    const key = normalize(label)
    if (!buckets.has(key)) buckets.set(key, { label: key, mensajes: 0, phones: new Set() })
    aliases.set(key, key)
    return key
  }
  add('BAJA')
  const overrides = object(params).buttons
  for (const component of Array.isArray(components) ? components : []) {
    const part = object(component)
    if (part.type !== 'BUTTONS' || !Array.isArray(part.buttons)) continue
    part.buttons.forEach((value: unknown, index: number) => {
      const button = object(value)
      if (button.type !== 'QUICK_REPLY' || typeof button.text !== 'string' || !button.text.trim()) return
      const key = add(button.text)
      const override = (Array.isArray(overrides) ? overrides : []).map(object).find(item => Number(item.index) === index && item.sub_type === 'quick_reply')
      if (typeof override?.payload === 'string' && override.payload.trim() && normalize(override.payload) !== 'BAJA') aliases.set(normalize(override.payload), key)
    })
  }
  const other = { label: 'Otras respuestas', mensajes: 0, phones: new Set<string>() }
  const people = new Set<string>()
  for (const reply of replies) {
    const keys = reply.candidates.map(normalize)
    const key = keys.includes('BAJA') ? 'BAJA' : keys.map(value => aliases.get(value)).find(Boolean)
    const bucket = (key && buckets.get(key)) || other
    bucket.mensajes += reply.count
    const phone = reply.phone?.replace(/\D/g, '')
    if (phone) { bucket.phones.add(phone); people.add(phone) }
  }
  return { personas: people.size, opciones: [...buckets.values(), other].map(({ label, mensajes, phones }) => ({ label, mensajes, personas: phones.size })) }
}
