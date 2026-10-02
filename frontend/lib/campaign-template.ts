import { z } from 'zod'

const httpsUrl = z.string().url().max(2048).refine(v => v.startsWith('https://'), 'Se requiere una URL HTTPS')
export const CampaignTemplateParamsSchema = z.object({
  body: z.array(z.string().trim().min(1).max(1024)).max(30).optional(),
  header: z.object({ type: z.enum(['image', 'video', 'document']), link: httpsUrl }).strict().optional(),
  buttons: z.array(z.object({ index: z.number().int().min(0).max(9), sub_type: z.enum(['url','quick_reply']), payload: z.string().trim().min(1).max(2048) }).strict()).max(10).optional(),
}).strict()

type Component = { type?: string; format?: string; text?: string; buttons?: { type?: string; url?: string }[] }
export function validateCampaignTemplate(components: unknown, params: z.infer<typeof CampaignTemplateParamsSchema>): string | null {
  if (!Array.isArray(components)) return 'La plantilla no tiene componentes válidos'
  const list = components as Component[]
  if (!list.some(c => c.type === 'BODY')) return 'La plantilla no tiene un cuerpo válido'
  const body = list.find(c => c.type === 'BODY')?.text ?? ''
  const placeholders = [...body.matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1])
  const numbers = [...new Set(placeholders)].sort((a,b) => Number(a)-Number(b))
  if (numbers.some((n,i) => n !== String(i+1))) return 'La plantilla usa variables no compatibles; usá variables numéricas consecutivas'
  if ((params.body?.length ?? 0) !== numbers.length) return `La plantilla requiere ${numbers.length} valores de cuerpo`
  const header = list.find(c => c.type === 'HEADER')
  if (header?.format && ['IMAGE','VIDEO','DOCUMENT'].includes(header.format)) {
    if (params.header?.type !== header.format.toLowerCase()) return 'Completá el archivo de cabecera requerido por la plantilla'
  } else {
    if (params.header) return 'Esta plantilla no admite un archivo de cabecera'
    if (header && (header.format !== 'TEXT' || /\{\{/.test(header.text ?? ''))) return 'La cabecera de esta plantilla todavía no es compatible con campañas'
  }
  if (list.some(c => !['BODY','HEADER','FOOTER','BUTTONS'].includes(c.type ?? ''))) return 'La plantilla contiene componentes no compatibles con campañas'
  const buttons = list.find(c => c.type === 'BUTTONS')?.buttons ?? []
  const supplied = params.buttons ?? []
  if (new Set(supplied.map(b=>b.index)).size !== supplied.length) return 'Hay parámetros de botón repetidos'
  for (const b of supplied) {
    const original = buttons[b.index]
    if (!original || original.type?.toLowerCase() !== b.sub_type) return 'Los parámetros de botón no coinciden con la plantilla'
    if (b.sub_type === 'url' && !original.url?.includes('{{1}}')) return 'No se puede parametrizar un botón con URL fija'
  }
  for (const [index,b] of buttons.entries()) {
    if (!['URL','QUICK_REPLY','PHONE_NUMBER'].includes(b.type ?? '')) return 'La plantilla contiene un botón no compatible'
    if (b.type === 'URL' && /\{\{/.test(b.url ?? '')) {
      if (!/\{\{1\}\}$/.test(b.url ?? '') || (b.url?.match(/\{\{/g)?.length ?? 0) !== 1) return 'La URL dinámica del botón no es compatible'
      if (!supplied.some(p=>p.index===index && p.sub_type==='url')) return 'Completá el valor del botón con URL dinámica'
    }
  }
  return null
}

// HTML datetime-local has no zone. Interpret legacy input explicitly in Argentina.
export function normalizeCampaignSchedule(value: string | null | undefined): string | null {
  if (!value?.trim()) return null
  const raw = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.test(raw)) throw new Error('Fecha de programación inválida')
  const withZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ? raw : `${raw}-03:00`
  const date = new Date(withZone)
  const day = raw.slice(0,10)
  const calendar = new Date(`${day}T12:00:00Z`)
  if (!Number.isFinite(date.getTime()) || calendar.toISOString().slice(0,10) !== day) throw new Error('Fecha de programación inválida')
  return date.toISOString()
}
