import { resolveTemplateContactValue } from '@/lib/campaign-personalization'

export interface TemplateButton { type?: string; text?: string; url?: string }
export interface TemplateComponent { type?: string; format?: string; text?: string; buttons?: TemplateButton[] }
export interface WaTemplate {
  id: string; name: string; language: string | null; status: string
  waba_id: string | null; components: TemplateComponent[] | string | null
}
export type TemplateHeaderType = 'image' | 'video' | 'document'
export interface TemplateAnalysis {
  bodyText: string
  bodyCount: number
  header: TemplateHeaderType | null
  buttons: { index: number; sub_type: 'url' | 'quick_reply'; label: string; required: boolean }[]
  unsupported: string[]
}
export interface TemplateParams {
  body?: string[]
  header?: { type: TemplateHeaderType; link: string }
  buttons?: { index: number; sub_type: 'url' | 'quick_reply'; payload: string }[]
}
export const HEADER_LABEL: Record<TemplateHeaderType, string> = { image: 'imagen', video: 'video', document: 'documento' }

// Determina qué parámetros pide la plantilla y qué componentes no se pueden enviar desde campañas.
// Replica las reglas de validateCampaignTemplate (lib/campaign-template.ts): tipos exactos en mayúsculas,
// variables de cuerpo {{1}}…{{N}} consecutivas y URL dinámica sólo con {{1}} al final.
export function analyzeTemplate(tpl: WaTemplate): TemplateAnalysis {
  let raw: unknown = tpl.components
  if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { raw = null } }
  const res: TemplateAnalysis = { bodyText: '', bodyCount: 0, header: null, buttons: [], unsupported: [] }
  if (!Array.isArray(raw)) {
    res.unsupported.push('La plantilla no tiene componentes válidos')
    return res
  }
  const comps: TemplateComponent[] = raw
  let hasBody = false
  for (const c of comps) {
    const type = c?.type ?? ''
    if (type === 'BODY') {
      if (hasBody) continue  // el backend sólo considera el primer cuerpo
      hasBody = true
      res.bodyText = c.text ?? ''
      const vars = [...new Set([...res.bodyText.matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1]))]
      const consecutive = vars.every(v => /^[1-9]\d*$/.test(v) && Number(v) <= vars.length)
      if (!consecutive) {
        res.unsupported.push(`Cuerpo con variables no compatibles (${vars.map(v => `{{${v}}}`).join(', ')}); sólo se admiten {{1}}, {{2}}… consecutivas`)
      } else if (vars.length > 30) {
        res.unsupported.push('Cuerpo con más de 30 variables')
      } else {
        res.bodyCount = vars.length
      }
    } else if (type === 'HEADER') {
      const format = c.format ?? ''
      if (format === 'IMAGE' || format === 'VIDEO' || format === 'DOCUMENT') {
        res.header = format.toLowerCase() as TemplateHeaderType
      } else if (format === 'TEXT') {
        if (/\{\{/.test(c.text ?? '')) res.unsupported.push('Encabezado de texto con variables')
      } else {
        res.unsupported.push(format ? `Encabezado de tipo ${format}` : 'Encabezado sin formato indicado')
      }
    } else if (type === 'FOOTER') {
      // Texto fijo: no requiere parámetros
    } else if (type === 'BUTTONS') {
      (Array.isArray(c.buttons) ? c.buttons : []).forEach((b, index) => {
        const bt = b?.type ?? ''
        const label = b?.text || `Botón ${index + 1}`
        if (bt === 'URL') {
          const url = b.url ?? ''
          if (!/\{\{/.test(url)) return  // URL fija: sin parámetros
          if (!/\{\{1\}\}$/.test(url) || (url.match(/\{\{/g)?.length ?? 0) !== 1) {
            res.unsupported.push(`Botón "${label}" con URL dinámica no compatible (sólo {{1}} al final)`)
          } else {
            res.buttons.push({ index, sub_type: 'url', label, required: true })
          }
        } else if (bt === 'QUICK_REPLY') {
          res.buttons.push({ index, sub_type: 'quick_reply', label, required: false })
        } else if (bt !== 'PHONE_NUMBER') {
          res.unsupported.push(`Botón "${label}" de tipo ${bt || 'desconocido'}`)
        }
      })
    } else {
      res.unsupported.push(`Componente ${type || 'desconocido'}`)
    }
  }
  if (!hasBody) res.unsupported.push('La plantilla no tiene cuerpo (BODY) legible')
  return res
}

// Límites de CampaignTemplateParamsSchema
const MAX_BODY_PARAM = 1024
const MAX_URL_LENGTH = 2048

export function buildTemplateParams(
  a: TemplateAnalysis, body: string[], headerLink: string, buttons: Record<number, string>,
): { params: TemplateParams; missing: string[]; invalid: string[] } {
  const params: TemplateParams = {}
  const missing: string[] = []
  const invalid: string[] = []
  if (a.bodyCount > 0) {
    params.body = Array.from({ length: a.bodyCount }, (_, i) => (body[i] ?? '').trim())
    params.body.forEach((v, i) => {
      if (!v) missing.push(`parámetro {{${i + 1}}} del cuerpo`)
      else if (v.length > MAX_BODY_PARAM) invalid.push(`el parámetro {{${i + 1}}} del cuerpo supera ${MAX_BODY_PARAM} caracteres`)
    })
  }
  if (a.header) {
    const link = headerLink.trim()
    if (!/^https:\/\/\S+$/i.test(link)) missing.push(`URL https del encabezado (${HEADER_LABEL[a.header]})`)
    else if (link.length > MAX_URL_LENGTH) invalid.push(`la URL del encabezado supera ${MAX_URL_LENGTH} caracteres`)
    params.header = { type: a.header, link }
  }
  const btns = a.buttons
    .map(b => ({ index: b.index, sub_type: b.sub_type, payload: (buttons[b.index] ?? '').trim(), required: b.required, label: b.label }))
  btns.forEach(b => {
    if (b.required && !b.payload) missing.push(`valor del botón "${b.label}"`)
    else if (b.payload.length > MAX_URL_LENGTH) invalid.push(`el valor del botón "${b.label}" supera ${MAX_URL_LENGTH} caracteres`)
  })
  const filled = btns.filter(b => b.payload).map(({ index, sub_type, payload }) => ({ index, sub_type, payload }))
  if (filled.length) params.buttons = filled
  return { params, missing, invalid }
}

export function fillTemplatePreview(text: string, values: string[]) {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => {
    const value = values[Number(n) - 1]?.trim()
    return value ? resolveTemplateContactValue(value, { first_name: 'pablo', phone_number: '[teléfono del contacto]' }, true) : m
  })
}

