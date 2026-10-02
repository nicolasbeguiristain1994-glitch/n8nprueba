/**
 * Validación compartida de plantillas creadas en el editor local.
 *
 * Browser-safe: solo depende de zod. La usan tanto la página de plantillas
 * como las rutas /api/templates, para que ambos lados acepten y rechacen
 * exactamente lo mismo. No aplicar a catálogos importados desde Meta: esos
 * pueden contener componentes que este editor no soporta.
 */

import { z } from 'zod'

export const TEMPLATE_NAME_MAX        = 100   // whatsapp_templates.name es VARCHAR(100) en producción
export const TEMPLATE_HEADER_MAX      = 60
export const TEMPLATE_BODY_MAX        = 1024
export const TEMPLATE_FOOTER_MAX      = 60
export const TEMPLATE_BUTTON_TEXT_MAX = 25
export const TEMPLATE_BUTTONS_MAX     = 3

export const TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'] as const
export const TEMPLATE_LANGUAGES  = ['es', 'es_AR', 'en', 'pt_BR', 'pt', 'fr', 'de', 'it', 'ar', 'zh_CN'] as const
export const TEMPLATE_STATUSES   = ['BORRADOR', 'EN_REVISION', 'APROBADA', 'RECHAZADA', 'DESHABILITADA'] as const

// ── Nombre ────────────────────────────────────────────────────────────────────

export function normalizeTemplateName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '_')
}

export const TemplateNameSchema = z.string({ error: 'El nombre es requerido' })
  .transform(normalizeTemplateName)
  .pipe(z.string()
    .min(1, 'El nombre es requerido')
    .max(TEMPLATE_NAME_MAX, `El nombre no puede superar ${TEMPLATE_NAME_MAX} caracteres`)
    .regex(/^[a-z0-9_]+$/, 'El nombre solo puede tener letras sin acentos, números y guiones bajos (_). Los espacios se convierten en _.'))

// ── Variables del cuerpo ──────────────────────────────────────────────────────

const VARIABLE_TOKEN = /\{\{([1-9]\d{0,2})\}\}/g

export type BodyVariableAnalysis = { variables: number[]; error: string | null }

/** Variables posicionales distintas ({{1}} repetida cuenta una vez) y el primer error de formato. */
export function analyzeBodyVariables(text: string): BodyVariableAnalysis {
  const found = new Set<number>()
  const matches = [...text.matchAll(VARIABLE_TOKEN)]
  let extraBrace = false
  for (const [i, m] of matches.entries()) {
    found.add(Number(m[1]))
    const start = m.index
    const end = start + m[0].length
    const previous = matches[i - 1]
    const next = matches[i + 1]
    // Adjacent valid tokens are allowed; unmatched braces touching a token are not.
    if ((/[{}]/.test(text[start - 1] ?? '') && (!previous || previous.index + previous[0].length !== start))
      || (/[{}]/.test(text[end] ?? '') && next?.index !== end)) extraBrace = true
  }
  const variables = [...found].sort((a, b) => a - b)
  const rest = text.replace(VARIABLE_TOKEN, '')
  if (extraBrace || rest.includes('{{') || rest.includes('}}')) {
    return { variables, error: 'Hay una variable mal escrita. Usá el formato {{1}}, {{2}}… sin espacios ni texto adentro.' }
  }
  const max = variables.at(-1) ?? 0
  const missing: string[] = []
  for (let n = 1; n <= max; n++) if (!found.has(n)) missing.push(`{{${n}}}`)
  if (missing.length) {
    return { variables, error: `Las variables deben ser consecutivas desde {{1}}. Falta ${missing.join(', ')}.` }
  }
  return { variables, error: null }
}

// ── Componentes ───────────────────────────────────────────────────────────────

const nonblank = (s: string) => s.trim().length > 0
const hasVariable = (s: string) => s.includes('{{') || s.includes('}}')

function isHttpUrl(value: string): boolean {
  if (hasVariable(value)) return false
  try {
    const url = new URL(value.trim())
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.length > 0
  } catch { return false }
}

const HeaderSchema = z.object({
  type:    z.literal('HEADER'),
  format:  z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'], { error: 'Formato de encabezado no soportado' }),
  text:    z.string().optional(),
  example: z.unknown().optional(),
}).superRefine((h, ctx) => {
  if (h.format !== 'TEXT') return
  const text = h.text ?? ''
  if (!nonblank(text)) ctx.addIssue({ code: 'custom', path: ['text'], message: 'Escribí el texto del encabezado o desactivalo.' })
  else if (text.length > TEMPLATE_HEADER_MAX) ctx.addIssue({ code: 'custom', path: ['text'], message: `El encabezado no puede superar ${TEMPLATE_HEADER_MAX} caracteres.` })
  else if (hasVariable(text)) ctx.addIssue({ code: 'custom', path: ['text'], message: 'El editor no admite variables en el encabezado.' })
})

const BodyExampleSchema = z.object({
  body_text: z.array(z.array(z.string({ error: 'Cada ejemplo debe ser texto.' }).trim()), {
    error: 'Los ejemplos de variables tienen un formato inválido.',
  }),
}, { error: 'Los ejemplos de variables tienen un formato inválido.' })

const BodySchema = z.object({
  type:    z.literal('BODY'),
  text:    z.string({ error: 'Escribí el cuerpo del mensaje.' })
    .refine(nonblank, 'Escribí el cuerpo del mensaje.')
    .refine(s => s.length <= TEMPLATE_BODY_MAX, `El cuerpo no puede superar ${TEMPLATE_BODY_MAX} caracteres.`),
  example: BodyExampleSchema.optional(),
}).superRefine((b, ctx) => {
  const { variables, error } = analyzeBodyVariables(b.text)
  if (error) { ctx.addIssue({ code: 'custom', path: ['text'], message: error }); return }
  const n = variables.length
  if (n === 0) {
    if (b.example) ctx.addIssue({ code: 'custom', path: ['example'], message: 'El cuerpo no tiene variables; quitá los ejemplos.' })
    return
  }
  const rows = b.example?.body_text
  if (!rows) {
    ctx.addIssue({ code: 'custom', path: ['example'], message: `Completá un ejemplo para cada variable (${variables.map(v => `{{${v}}}`).join(', ')}).` })
    return
  }
  if (rows.length !== 1) {
    ctx.addIssue({ code: 'custom', path: ['example', 'body_text'], message: 'Los ejemplos de variables tienen un formato inválido.' })
    return
  }
  const row = rows[0]
  if (row.length > n) {
    ctx.addIssue({ code: 'custom', path: ['example', 'body_text', 0], message: `Hay ${row.length} ejemplos pero el cuerpo usa ${n} variable${n === 1 ? '' : 's'}.` })
  }
  for (let i = 0; i < n; i++) {
    if (!nonblank(row[i] ?? '')) {
      ctx.addIssue({ code: 'custom', path: ['example', 'body_text', 0, i], message: `Completá el ejemplo de {{${i + 1}}}.` })
    }
  }
})

const FooterSchema = z.object({
  type: z.literal('FOOTER'),
  text: z.string({ error: 'Escribí el texto del pie de página o desactivalo.' })
    .refine(nonblank, 'Escribí el texto del pie de página o desactivalo.')
    .refine(s => s.length <= TEMPLATE_FOOTER_MAX, `El pie de página no puede superar ${TEMPLATE_FOOTER_MAX} caracteres.`)
    .refine(s => !hasVariable(s), 'El pie de página no admite variables.'),
})

const ButtonTextSchema = z.string({ error: 'Escribí el texto del botón.' })
  .refine(nonblank, 'Escribí el texto del botón.')
  .refine(s => s.length <= TEMPLATE_BUTTON_TEXT_MAX, `El texto del botón no puede superar ${TEMPLATE_BUTTON_TEXT_MAX} caracteres.`)

const ButtonSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('QUICK_REPLY'), text: ButtonTextSchema }),
  z.object({
    type: z.literal('URL'),
    text: ButtonTextSchema,
    url:  z.string({ error: 'Ingresá la URL del botón.' })
      .refine(isHttpUrl, 'Ingresá una URL válida que empiece con http:// o https:// (sin variables).'),
  }),
  z.object({
    type:         z.literal('PHONE_NUMBER'),
    text:         ButtonTextSchema,
    phone_number: z.string({ error: 'Ingresá el teléfono del botón.' })
      .regex(/^\+[1-9]\d{7,14}$/, 'Ingresá el teléfono en formato internacional, con +, hasta 15 dígitos y sin espacios (ej.: +5491100000000).'),
  }),
], { error: 'Tipo de botón no soportado.' })

const ButtonsSchema = z.object({
  type:    z.literal('BUTTONS'),
  buttons: z.array(ButtonSchema, { error: 'Los botones tienen un formato inválido.' })
    .min(1, 'Agregá al menos un botón o desactivá la sección de botones.')
    .max(TEMPLATE_BUTTONS_MAX, `Máximo ${TEMPLATE_BUTTONS_MAX} botones.`),
})

export const TemplateComponentSchema = z.discriminatedUnion('type', [HeaderSchema, BodySchema, FooterSchema, ButtonsSchema], {
  error: 'Tipo de componente no soportado. Usá encabezado, cuerpo, pie de página o botones.',
})
export type TemplateComponentInput = z.infer<typeof TemplateComponentSchema>

export const TemplateComponentsSchema = z.array(TemplateComponentSchema, { error: 'Agregá el cuerpo del mensaje (BODY).' })
  .superRefine((components, ctx) => {
    const seen = new Set<string>()
    components.forEach((c, i) => {
      if (seen.has(c.type)) ctx.addIssue({ code: 'custom', path: [i, 'type'], message: `El componente ${c.type} está repetido.` })
      seen.add(c.type)
    })
    if (!seen.has('BODY')) ctx.addIssue({ code: 'custom', path: [], message: 'Agregá el cuerpo del mensaje (BODY).' })
  })

const CategorySchema = z.enum(TEMPLATE_CATEGORIES, { error: 'Elegí una categoría válida.' })
const LanguageSchema = z.enum(TEMPLATE_LANGUAGES, { error: 'Elegí un idioma soportado.' })

export const CreateTemplateSchema = z.object({
  name:       TemplateNameSchema,
  category:   CategorySchema,
  language:   LanguageSchema.optional().default('es'),
  components: TemplateComponentsSchema,
})
export type CreateTemplateInput = z.infer<typeof CreateTemplateSchema>

export const UpdateTemplateSchema = z.object({
  name:             TemplateNameSchema.optional(),
  category:         CategorySchema.optional(),
  language:         LanguageSchema.optional(),
  components:       TemplateComponentsSchema.optional(),
  status:           z.enum(TEMPLATE_STATUSES, { error: 'Estado inválido.' }).optional(),
  rejection_reason: z.string().max(1000).optional().nullable(),
})
export type UpdateTemplateInput = z.infer<typeof UpdateTemplateSchema>

// ── Ejemplos del cuerpo (editor) ──────────────────────────────────────────────

/** Ejemplos explícitos guardados en BODY.example.body_text[0], indexados por variable - 1. */
export function readBodyExamples(components: unknown): string[] {
  if (!Array.isArray(components)) return []
  const body = components.find(c => (c as { type?: unknown })?.type === 'BODY') as { example?: { body_text?: unknown } } | undefined
  const rows: unknown = body?.example?.body_text
  const row: unknown = Array.isArray(rows) ? rows[0] : undefined
  return Array.isArray(row) ? row.map(v => (typeof v === 'string' ? v : '')) : []
}

/** Arma BODY con los ejemplos tal como los ingresó el usuario; nunca inventa valores. */
export function buildBodyComponent(text: string, examples: readonly string[]) {
  const { variables } = analyzeBodyVariables(text)
  if (!variables.length) return { type: 'BODY' as const, text }
  return { type: 'BODY' as const, text, example: { body_text: [variables.map(n => examples[n - 1] ?? '')] } }
}

// ── Errores por campo ─────────────────────────────────────────────────────────

/**
 * Campo del editor al que pertenece un error: name, category, language, header,
 * body, bodyExamples, bodyExample.N (N = número de variable), footer, buttons,
 * button.I (I = índice del botón) o components.
 */
export function templateIssueField(path: readonly PropertyKey[], components: unknown): string {
  const [root, index, key, , , position] = path
  if (root !== 'components') return typeof root === 'string' ? root : 'form'
  if (typeof index !== 'number') return 'body'
  const type = Array.isArray(components) ? (components[index] as { type?: unknown } | undefined)?.type : undefined
  switch (type) {
    case 'HEADER':  return 'header'
    case 'FOOTER':  return 'footer'
    case 'BUTTONS': return typeof path[3] === 'number' ? `button.${path[3]}` : 'buttons'
    case 'BODY':
      if (key !== 'example') return 'body'
      return typeof position === 'number' ? `bodyExample.${position + 1}` : 'bodyExamples'
    default:        return 'components'
  }
}

export type TemplateIssue = { path: readonly PropertyKey[] | string; message: string }

/** Primer mensaje por campo; acepta issues de zod o los devueltos por la API ("components.1.text"). */
export function collectTemplateErrors(issues: readonly TemplateIssue[], components: unknown): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const issue of issues) {
    const path = typeof issue.path === 'string'
      ? issue.path.split('.').filter(p => p && p !== 'root').map(p => (/^\d+$/.test(p) ? Number(p) : p))
      : issue.path
    const field = templateIssueField(path, components)
    errors[field] ??= issue.message
  }
  return errors
}

export type TemplateDraftResult =
  | { ok: true; data: CreateTemplateInput }
  | { ok: false; errors: Record<string, string> }

export function validateTemplateDraft(input: {
  name: string; category: string; language: string; components: unknown[]
}): TemplateDraftResult {
  const result = CreateTemplateSchema.safeParse(input)
  if (result.success) return { ok: true, data: result.data }
  return { ok: false, errors: collectTemplateErrors(result.error.issues, input.components) }
}
