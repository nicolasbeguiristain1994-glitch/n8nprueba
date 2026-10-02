export const CONTACT_NAME_VARIABLE = '{{first_name}}'

type TemplateContact = { first_name: string | null; phone_number: string | null }

export function hasTemplateContactName(value: string): boolean {
  return /\{\{\s*(?:first_name|nombre|name)\s*\}\}/i.test(value)
}

// Shared by the preview and dispatch. Button values keep their original casing.
export function resolveTemplateContactValue(
  value: string, contact: TemplateContact, formatName = false,
): string {
  const rawName = contact.first_name || ''
  const trimmedName = rawName.trim()
  const name = formatName
    ? trimmedName.charAt(0).toLocaleUpperCase('es-AR') + trimmedName.slice(1)
    : rawName
  return value.replace(/\{\{\s*(first_name|nombre|name|phone_number)\s*\}\}/gi, (_, field: string) =>
    field.toLowerCase() === 'phone_number' ? contact.phone_number || '' : name,
  )
}
