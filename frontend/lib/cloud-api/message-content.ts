// Shared display text for stored Cloud messages and SQL conversation previews.
export type CloudMessageContent = {
  type?: string
  text?: { body?: string }
  button?: { text?: string; payload?: string }
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } }
  image?: { caption?: string }
  video?: { caption?: string }
  document?: { caption?: string; filename?: string }
  template?: { name?: string }
  reaction?: { emoji?: string }
}
const textPaths = [
  ['text','body'], ['button','text'], ['interactive','button_reply','title'],
  ['interactive','list_reply','title'], ['image','caption'], ['video','caption'],
  ['document','caption'], ['document','filename'], ['template','name'], ['reaction','emoji'],
] as const
export function cloudMessageText(content: CloudMessageContent | null | undefined, type?: string): string {
  for (const path of textPaths) {
    let value: unknown = content
    for (const key of path) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
    if (typeof value === 'string' && value.length) return value
  }
  return `[${type || content?.type || 'mensaje'}]`
}
// Columns are static identifiers supplied by application code, never request data.
export function cloudMessageTextSql(content: string, type: string): string {
  if (![content,type].every(column => /^[a-z_]+\.[a-z_]+$/.test(column))) throw Error('Invalid SQL column')
  return `COALESCE(${textPaths.map(path => `NULLIF(${content} #>> '{${path.join(',')}}','')`).join(',')}, '[' || ${type} || ']')`
}
