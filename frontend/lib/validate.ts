export function isE164(phone: string): boolean {
  return /^\+[0-9]{10,15}$/.test(phone)
}

export function isUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

export function isInstanceName(s: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(s)
}

export function clampStr(s: unknown, max: number): string | null {
  if (typeof s !== 'string' || s.trim() === '') return null
  return s.trim().slice(0, max)
}
