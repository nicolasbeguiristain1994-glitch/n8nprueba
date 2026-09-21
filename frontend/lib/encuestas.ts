import crypto from 'node:crypto'
import { z } from 'zod'
import { MemoryRateLimiter, RedisRateLimiter, type RateLimiterAdapter } from '@/lib/rate-limit'

// ── Tipos ─────────────────────────────────────────────────────────────────────

export type QuestionType = 'rating' | 'multiple' | 'text' | 'select'

export interface Question {
  id:          string
  type:        QuestionType
  label:       string
  required?:   boolean
  options?:    string[]           // multiple / select
  min?:        number             // rating (default 1)
  max?:        number             // rating (default 5)
  helpText?:   string

  // "Otros (especificar)" — sólo aplica a 'multiple'.
  // Cuando `allowOther=true`, si el usuario selecciona la opción cuyo texto
  // coincide con `otherOption` (por defecto: 'Otros'), el form muestra un
  // input adicional que se persiste como `<id>_other` en `answers`.
  allowOther?:  boolean
  otherOption?: string
  otherLabel?:  string
}

export interface EncuestaRow {
  id:          string
  slug:        string
  title:       string
  description: string | null
  questions:   Question[]
  is_active:   boolean
  created_at:  string
  updated_at:  string
}

// ── Zod: definición de una encuesta ──────────────────────────────────────────
//
// Se usa tanto en el admin (crear/editar) como en el submit público (validar
// respuestas contra la definición leída de DB).

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,63}$/

const QUESTION_ID_REGEX = /^[a-zA-Z0-9_]{1,32}$/

export const QuestionSchema = z.object({
  id:          z.string().regex(QUESTION_ID_REGEX, 'id inválido (a-z, 0-9, _)'),
  type:        z.enum(['rating', 'multiple', 'text', 'select']),
  label:       z.string().trim().min(1).max(200),
  required:    z.boolean().optional(),
  options:     z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  min:         z.number().int().min(0).max(10).optional(),
  max:         z.number().int().min(1).max(10).optional(),
  helpText:    z.string().trim().max(200).optional(),
  allowOther:  z.boolean().optional(),
  otherOption: z.string().trim().min(1).max(80).optional(),
  otherLabel:  z.string().trim().max(80).optional(),
}).refine(
  q => q.type !== 'multiple' && q.type !== 'select' ? true : (q.options && q.options.length >= 2),
  { message: 'multiple/select requiere al menos 2 opciones', path: ['options'] },
).refine(
  q => !q.allowOther || (q.type === 'multiple' && q.options?.includes(q.otherOption ?? 'Otros')),
  { message: "allowOther=true requiere type='multiple' y que otherOption exista en options", path: ['allowOther'] },
)

export const EncuestaSchema = z.object({
  slug:        z.string().regex(SLUG_REGEX, 'slug inválido (minúsculas, dígitos y guiones)'),
  title:       z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  questions:   z.array(QuestionSchema).min(1).max(15),
  is_active:   z.boolean().optional(),
})

export type EncuestaInput = z.infer<typeof EncuestaSchema>

export const EncuestaPatchSchema = EncuestaSchema.partial()

// ── Validación de respuestas del formulario público ──────────────────────────
//
// Recibe un `answers: Record<questionId, unknown>` y la definición de la
// encuesta. Devuelve el objeto sanitizado listo para persistir, o un error
// legible.

type SanitizedAnswer = string | number | string[]

export function sanitizeAnswers(
  raw:       unknown,
  questions: Question[],
): { ok: true; answers: Record<string, SanitizedAnswer> } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Respuestas inválidas' }
  }
  const input = raw as Record<string, unknown>
  const out: Record<string, SanitizedAnswer> = {}

  for (const q of questions) {
    const value = input[q.id]
    const isEmpty =
      value === undefined || value === null ||
      (typeof value === 'string' && value.trim() === '') ||
      (Array.isArray(value) && value.length === 0)

    if (isEmpty) {
      if (q.required) return { ok: false, error: `Falta responder: ${q.label}` }
      continue
    }

    switch (q.type) {
      case 'text': {
        if (typeof value !== 'string') return { ok: false, error: `Formato inválido en ${q.label}` }
        const trimmed = value.trim().slice(0, 500)
        if (!trimmed) {
          if (q.required) return { ok: false, error: `Falta responder: ${q.label}` }
          break
        }
        out[q.id] = trimmed
        break
      }
      case 'rating': {
        const n = typeof value === 'number' ? value : Number(value)
        if (!Number.isFinite(n)) return { ok: false, error: `Puntaje inválido en ${q.label}` }
        const min = q.min ?? 1
        const max = q.max ?? 5
        const rounded = Math.round(n)
        if (rounded < min || rounded > max) {
          return { ok: false, error: `Puntaje fuera de rango en ${q.label}` }
        }
        out[q.id] = rounded
        break
      }
      case 'select': {
        if (typeof value !== 'string' || !q.options?.includes(value)) {
          return { ok: false, error: `Opción inválida en ${q.label}` }
        }
        out[q.id] = value
        break
      }
      case 'multiple': {
        if (!Array.isArray(value)) return { ok: false, error: `Formato inválido en ${q.label}` }
        const opts = q.options ?? []
        const picked: string[] = []
        for (const v of value) {
          if (typeof v !== 'string' || !opts.includes(v)) {
            return { ok: false, error: `Opción inválida en ${q.label}` }
          }
          if (!picked.includes(v)) picked.push(v)
        }
        if (picked.length === 0) {
          if (q.required) return { ok: false, error: `Falta responder: ${q.label}` }
          break
        }
        out[q.id] = picked

        // "Otros (especificar)": si la pregunta lo habilita y el usuario
        // eligió la opción de otros, buscamos el texto libre en input[qid + '_other'].
        // El texto es opcional (nunca bloquea el submit) — se sanea como plain text.
        if (q.allowOther) {
          const otherKey = q.otherOption ?? 'Otros'
          if (picked.includes(otherKey)) {
            const otherRaw = input[`${q.id}_other`]
            if (typeof otherRaw === 'string') {
              const cleaned = otherRaw.trim().slice(0, 200)
              if (cleaned) out[`${q.id}_other`] = cleaned
            }
          }
        }
        break
      }
    }
  }

  return { ok: true, answers: out }
}

// ── Rate-limit para submits públicos ─────────────────────────────────────────
//
// 10 submits por IP cada 10 minutos. Redis si REDIS_URL está seteada,
// memoria si no. Mismo patrón que loginRateLimiter.

const SURVEY_CONFIG = { maxAttempts: 10, windowMs: 10 * 60 * 1000 }

export const surveySubmitLimiter: RateLimiterAdapter = process.env.REDIS_URL
  ? new RedisRateLimiter(SURVEY_CONFIG, 'rl:encuesta')
  : new MemoryRateLimiter(SURVEY_CONFIG)

// ── Utils ─────────────────────────────────────────────────────────────────────

const IP_HASH_SALT = process.env.SURVEY_IP_SALT ?? 'encuestas-wa-default-salt'

export function hashIp(ip: string | null): string | null {
  if (!ip) return null
  return crypto.createHash('sha256').update(`${IP_HASH_SALT}:${ip}`).digest('hex')
}

export function getIp(req: Request): string | null {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    req.headers.get('x-real-ip') ||
    null
  )
}

// ── Username / email del jugador ─────────────────────────────────────────────
//
// El username es la identidad que usa el operador para chequear a quién darle
// bono. Aceptamos letras, dígitos y `._-`. Sin espacios ni acentos para
// mantenerlo grep-friendly en el CRM y evitar collisions por normalización.

const USERNAME_REGEX = /^[a-zA-Z0-9._-]{3,60}$/
const EMAIL_MAX_LEN  = 254

export function sanitizeUsername(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!USERNAME_REGEX.test(s)) return null
  return s
}

export function sanitizeEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (!s) return null
  if (s.length > EMAIL_MAX_LEN) return null
  // Validación conservadora: local@domain.tld. No es RFC 5322 completa (no
  // aceptamos quoted-strings ni IPs), pero cubre >99% de casos legítimos.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return null
  return s
}

// Truncado defensivo para strings de tracking (campaign/source) recibidos por
// query params — evita persistir payloads absurdos.
export function clampTracking(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  // Solo alfanum, guiones y underscores (evita XSS al re-mostrar).
  if (!/^[a-zA-Z0-9_.-]{1,60}$/.test(s)) return null
  return s
}
