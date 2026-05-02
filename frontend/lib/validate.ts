export function isE164(phone: string): boolean {
  return /^\+[0-9]{10,15}$/.test(phone)
}

/**
 * Normaliza un número de teléfono a dígitos puros sin prefijo '+'.
 * Elimina espacios, guiones, paréntesis, puntos.
 * Devuelve null si el resultado no tiene entre 7 y 15 dígitos.
 *
 * Se usa internamente para comparar números en la blacklist de forma robusta:
 * "54 9 11 5555-1234", "+54911 5555 1234" y "+5491155551234" son el mismo número.
 *
 * Límites conocidos: no intenta reconstruir códigos de país faltantes.
 * Si el número no trae prefijo internacional no puede garantizarse unicidad.
 */
export function normalizePhone(raw: string): string | null {
  if (typeof raw !== 'string') return null
  // Quitar todo lo que no sea dígito o '+'
  const digits = raw.replace(/[^\d+]/g, '')
  // Quitar '+' inicial para quedarnos solo con dígitos
  const onlyDigits = digits.replace(/^\+/, '')
  if (onlyDigits.length < 7 || onlyDigits.length > 15) return null
  return onlyDigits
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
