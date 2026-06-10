/**
 * Centralised input validation.
 *
 * Pattern for route handlers:
 *
 *   const body = await req.json().catch(() => null)
 *   const parsed = parseBody(CreateUserSchema, body)
 *   if (!parsed.ok) return handleValidationError(req, parsed.error, 'users')
 *   const { email, role } = parsed.data
 */

import { z }          from 'zod'
import { NextResponse } from 'next/server'
import { audit }       from '@/lib/audit'
import { securityLog } from '@/lib/security-log'

// ── Generic parse helper ──────────────────────────────────────────────────────

type ParseOk<T>  = { ok: true;  data: T }
type ParseFail   = { ok: false; error: z.ZodError }
export type ParseResult<T> = ParseOk<T> | ParseFail

/**
 * Validate `data` against `schema`.
 * Returns { ok, data } on success or { ok, error } on failure. Never throws.
 */
export function parseBody<T>(
  schema: z.ZodType<T>,
  data:   unknown,
): ParseResult<T> {
  const result = schema.safeParse(data)
  if (result.success) return { ok: true, data: result.data }
  return { ok: false, error: result.error }
}

/**
 * Build a consistent 400 response from a ZodError and fire a non-blocking
 * audit event so that repeated malformed requests are traceable.
 */
export async function handleValidationError(
  req:      Request,
  error:    z.ZodError,
  resource: string,
): Promise<NextResponse> {
  const issues = error.issues.map(issue => ({
    path:    issue.path.join('.') || 'root',
    message: issue.message,
  }))

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim()
           || req.headers.get('x-real-ip')
           || 'unknown'
  securityLog('validation_failed', { ip, resource, fields: issues.map(i => i.path) })

  // Fire-and-forget — a logging failure must not affect the HTTP response.
  void audit({
    req,
    action:   'validation_failed',
    resource,
    status:   'failure',
    metadata: { issues },
  })

  return NextResponse.json({ error: 'Validation failed', issues }, { status: 400 })
}

// ── Shared enums ──────────────────────────────────────────────────────────────

export const ROLES   = ['admin', 'operator', 'viewer']   as const
export const SECTORS = [
  'dashboard', 'contacts', 'campaigns', 'conversations', 'lines',
  'warmup', 'tasks', 'estadisticas', 'automations', 'blacklist',
  'templates', 'tickets', 'users', 'settings', 'lists', 'send',
] as const

const RoleEnum    = z.enum(ROLES)
const SectorsArray = z.array(z.enum(SECTORS))

// ── User schemas ──────────────────────────────────────────────────────────────

export const CreateUserSchema = z.object({
  email:    z.string().email('Invalid email').max(254).transform(s => s.toLowerCase().trim()),
  password: z.string().min(10, 'Password must be at least 10 characters').max(128),
  name:     z.string().max(120).trim().nullable().optional(),
  role:     RoleEnum,
  sectors:  SectorsArray,
  can_download_contacts: z.boolean().optional().default(true),
  allowed_agents:        z.array(z.string().max(64)).optional().default([]),
})
export type CreateUserInput = z.infer<typeof CreateUserSchema>

export const UpdateUserSchema = z.object({
  name:     z.string().max(120).trim().nullable().optional(),
  role:     RoleEnum.optional(),
  sectors:  SectorsArray.optional(),
  is_active: z.boolean().optional(),
  password: z.string().min(10, 'Password must be at least 10 characters').max(128).optional(),
  can_download_contacts: z.boolean().optional(),
  allowed_agents: z.array(z.string().max(64)).optional(),
}).strict() // reject unknown keys to prevent mass-assignment
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>

// ── Auth schemas ──────────────────────────────────────────────────────────────

export const LoginSchema = z.object({
  email:    z.string().max(254).optional(),
  username: z.string().max(254).optional(),
  password: z.string().min(1, 'Password is required').max(256),
})
export type LoginInput = z.infer<typeof LoginSchema>

// ── Contact schemas ───────────────────────────────────────────────────────────

export const UpdateContactSchema = z.object({
  segment:    z.enum(['bajo', 'medio', 'vip', 'vip_medio', 'vip_alto', 'super_vip']).nullable().optional(),
  gaming:     z.enum(['slots', 'deportivas', 'ambas']).nullable().optional(),
  panel:      z.enum(['Betcoin', 'Zeus', 'Bigwin', 'Farabet', 'Las Vegas']).nullable().optional(),
  linea:      z.number().int().min(1).max(100).nullable().optional(),
  first_name: z.string().max(100).nullable().optional(),
  last_name:  z.string().max(100).nullable().optional(),
})
export type UpdateContactInput = z.infer<typeof UpdateContactSchema>

// ── Send schemas ──────────────────────────────────────────────────────────────

export const SendSchema = z.object({
  phones:      z.array(z.string().min(1))
                 .min(1,   'phones debe tener al menos 1 número')
                 .max(100, 'phones no puede tener más de 100 números'),
  message:     z.string().trim().min(1, 'message es requerido y no puede estar vacío').max(4096),
  campaign_id: z.string().uuid('campaign_id debe ser un UUID válido').optional().nullable(),
  media_url:   z.string().max(2048).optional().nullable(),
  media_type:  z.string().max(50).optional().nullable(),
})
export type SendInput = z.infer<typeof SendSchema>

// ── Blacklist schemas ─────────────────────────────────────────────────────────

export const CreateBlacklistSchema = z.object({
  // Acepta un string con números separados por salto de línea/coma, o un array directo.
  phones: z.union([
    z.string().min(1),
    z.array(z.string().min(1)).min(1, 'Debe ingresar al menos un número'),
  ]),
  reason: z.string().max(500).optional(),
})
export type CreateBlacklistInput = z.infer<typeof CreateBlacklistSchema>

// ── Campaign schemas ──────────────────────────────────────────────────────────

const CAMPAIGN_TYPES = ['promotion', 'retention', 'onboarding', 'support', 'survey', 'payment', 'risk_alert'] as const
const DELAY_TYPES    = ['gaussian', 'human_noisy', 'uniform'] as const

export const CreateCampaignSchema = z.object({
  name:                 z.string().min(1, 'El nombre de la campaña es requerido').max(255),
  message:              z.string().max(4096).optional(),
  messages:             z.array(z.string().max(4096)).min(1).max(10).optional(),
  media_url:            z.string().max(2048).optional().nullable(),
  media_type:           z.string().max(50).optional().nullable(),
  list_id:              z.string().uuid('list_id debe ser un UUID válido').optional().nullable(),
  prospect_list_id:     z.string().uuid('prospect_list_id debe ser un UUID válido').optional().nullable(),
  scheduled_at:         z.string().optional().nullable(),
  antiblock_delay_min:  z.number().min(1).optional(),
  antiblock_delay_max:  z.number().min(1).optional(),
  type:                 z.enum(CAMPAIGN_TYPES).optional(),
  personalize_name:     z.boolean().optional(),
  use_multi_line:       z.boolean().optional(),
  delay_type:           z.enum(DELAY_TYPES).optional(),
  custom_delay_seconds: z.number().min(5).optional(),
  daily_limit_override: z.number().min(5).optional().nullable(),
  anti_ban_profile_id:  z.string().uuid('anti_ban_profile_id debe ser un UUID válido').optional().nullable(),
  enable_mini_sessions: z.boolean().optional(),
  mini_session_text:    z.string().max(500).optional(),
})
export type CreateCampaignInput = z.infer<typeof CreateCampaignSchema>

export const UpdateCampaignStatusSchema = z.object({
  status: z.enum(['paused', 'cancelled', 'draft'], {
    message: 'status debe ser paused, cancelled o draft',
  }),
})
export type UpdateCampaignStatusInput = z.infer<typeof UpdateCampaignStatusSchema>

// ── Settings schemas ──────────────────────────────────────────────────────────

export const UpdateSettingsSchema = z
  .record(z.string(), z.unknown())
  .refine(obj => Object.keys(obj).length > 0, { message: 'No hay campos para actualizar' })
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>

// ── Casino player schemas ─────────────────────────────────────────────────────

const CASINO_LABEL_REGEX = /^[a-zA-Z0-9áéíóúÁÉÍÓÚñÑüÜ\s\-_]+$/

export const UpdateCasinoPlayerSchema = z.object({
  labels: z
    .array(
      z.string().trim()
        .min(1)
        .max(40, 'Label demasiado larga (máximo 40 caracteres)')
        .regex(CASINO_LABEL_REGEX, 'Label contiene caracteres inválidos'),
    )
    .max(10, 'Máximo 10 etiquetas por jugador'),
})
export type UpdateCasinoPlayerInput = z.infer<typeof UpdateCasinoPlayerSchema>

// ── Template schemas ──────────────────────────────────────────────────────────

const TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'] as const
const TEMPLATE_LANGUAGES  = ['es', 'en', 'pt_BR', 'pt', 'fr', 'de', 'it', 'ar', 'zh_CN'] as const
const TEMPLATE_STATUSES   = ['BORRADOR', 'EN_REVISION', 'APROBADA', 'RECHAZADA', 'DESHABILITADA'] as const

const TemplateComponentSchema = z.record(z.string(), z.unknown())

export const CreateTemplateSchema = z.object({
  name:       z.string().min(1, 'El nombre es requerido').max(255),
  category:   z.enum(TEMPLATE_CATEGORIES),
  language:   z.enum(TEMPLATE_LANGUAGES).optional().default('es'),
  components: z.array(TemplateComponentSchema).optional().default([]),
})
export type CreateTemplateInput = z.infer<typeof CreateTemplateSchema>

export const UpdateTemplateSchema = z.object({
  name:             z.string().min(1).max(255).optional(),
  category:         z.enum(TEMPLATE_CATEGORIES).optional(),
  language:         z.enum(TEMPLATE_LANGUAGES).optional(),
  components:       z.array(TemplateComponentSchema).optional(),
  status:           z.enum(TEMPLATE_STATUSES).optional(),
  rejection_reason: z.string().max(1000).optional().nullable(),
})
export type UpdateTemplateInput = z.infer<typeof UpdateTemplateSchema>

// ── Automation schemas ────────────────────────────────────────────────────────

const AUTOMATION_TYPES = ['reply', 'flow', 'handoff'] as const
const TRIGGER_TYPES    = ['keyword', 'contains', 'any_inbound'] as const

export const CreateAutomationSchema = z.object({
  name:           z.string().min(1, 'El nombre es requerido').max(200),
  description:    z.string().max(500).optional().nullable(),
  type:           z.enum(AUTOMATION_TYPES, { message: 'Tipo inválido' }),
  trigger_type:   z.enum(TRIGGER_TYPES, { message: 'Tipo de trigger inválido' }),
  trigger_config: z.record(z.string(), z.unknown()).optional().default({}),
  action_config:  z.record(z.string(), z.unknown()).optional().default({}),
  is_active:      z.boolean().optional().default(true),
  priority:       z.number().int().min(1).max(1000).optional().default(100),
})
export type CreateAutomationInput = z.infer<typeof CreateAutomationSchema>

export const UpdateAutomationSchema = z.object({
  name:           z.string().min(1).max(200).optional(),
  description:    z.string().max(500).nullable().optional(),
  type:           z.enum(AUTOMATION_TYPES).optional(),
  trigger_type:   z.enum(TRIGGER_TYPES).optional(),
  trigger_config: z.record(z.string(), z.unknown()).optional(),
  action_config:  z.record(z.string(), z.unknown()).optional(),
  is_active:      z.boolean().optional(),
  priority:       z.number().int().min(1).max(1000).optional(),
})
export type UpdateAutomationInput = z.infer<typeof UpdateAutomationSchema>

// ── Line schemas ──────────────────────────────────────────────────────────────

export const PatchLineSchema = z.object({
  id:              z.string().uuid('id must be a valid UUID'),
  sending_enabled: z.boolean().optional(),
  display_name:    z.string().trim().min(1, 'display_name no puede estar vacío').max(100).optional(),
  msg_per_day:     z.number().min(1, 'msg_per_day debe ser >= 1').optional(),
  msg_per_hour:    z.number().min(1, 'msg_per_hour debe ser >= 1').optional(),
  priority:        z.number().optional(),
})
export type PatchLineInput = z.infer<typeof PatchLineSchema>

export const CreateLineSchema = z.object({
  evolution_instance: z.string().min(1, 'evolution_instance is required').max(200),
  display_name:       z.string().max(200).optional(),
  phone_number:       z.string().optional().nullable(),
})
export type CreateLineInput = z.infer<typeof CreateLineSchema>

export const DeleteLineSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
})
export type DeleteLineInput = z.infer<typeof DeleteLineSchema>

export const GrantLineSchema = z.object({
  line_id:    z.string().uuid('line_id debe ser un UUID válido'),
  granted_to: z.string().uuid('granted_to debe ser un UUID válido'),
})
export type GrantLineInput = z.infer<typeof GrantLineSchema>

export const RevokeGrantSchema = z.object({
  line_id:    z.string().uuid('line_id debe ser un UUID válido'),
  granted_to: z.string().uuid('granted_to debe ser un UUID válido'),
})
export type RevokeGrantInput = z.infer<typeof RevokeGrantSchema>

// ── Cloud sync schemas ────────────────────────────────────────────────────────

const SMB_SYNC_TYPES = ['smb_app_state_sync', 'history'] as const

export const CloudSyncSchema = z.object({
  phoneNumberId: z.string().min(1, 'phoneNumberId es requerido'),
  syncType:      z.enum(SMB_SYNC_TYPES).optional().default('history'),
  historyDays:   z.number().int().min(1).max(365).optional().default(180),
})
export type CloudSyncInput = z.infer<typeof CloudSyncSchema>

// ── Warmup schemas ────────────────────────────────────────────────────────────

const WARMUP_DELAY_PRESETS = ['conservadora', 'normal', 'agresiva'] as const
const WARMUP_STATUSES      = ['active', 'paused', 'completed', 'banned'] as const
const WARMUP_RANDOMNESS    = ['low', 'medium', 'high'] as const

export const CreateWarmupSchema = z.object({
  phone_number:  z.string()
    .regex(/^\+[0-9]{10,15}$/, 'phone_number debe estar en formato E.164 (ej: +5491112345678)'),
  instance_name: z.string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/, 'instance_name inválido (solo letras, números, _ y -, máx 64 caracteres)'),
  display_name:  z.string().max(100).optional().nullable(),
  target_days:   z.number().int().min(1).optional().default(21),
  daily_limit:   z.number().int().min(1).optional().default(10),
  notes:         z.string().max(1000).optional().nullable(),
  timezone:      z.string().max(50).optional(),
  delay_preset:  z.enum(WARMUP_DELAY_PRESETS).optional().default('normal'),
})
export type CreateWarmupInput = z.infer<typeof CreateWarmupSchema>

// ── Prospect list schemas ─────────────────────────────────────────────────────

export const CreateProspectListSchema = z.object({
  name:        z.string().min(1, 'El nombre es requerido').max(255),
  description: z.string().max(1000).optional().nullable(),
})
export type CreateProspectListInput = z.infer<typeof CreateProspectListSchema>

export const AddProspectListMembersSchema = z.object({
  prospect_ids: z
    .array(z.string().uuid('ID de prospecto inválido'))
    .min(1, 'Se requiere al menos un prospecto')
    .max(5000, 'No se pueden agregar más de 5000 prospectos a la vez'),
})
export type AddProspectListMembersInput = z.infer<typeof AddProspectListMembersSchema>

export const CreateListFromSelectionSchema = z.object({
  name:        z.string().min(1, 'El nombre es requerido').max(255),
  description: z.string().max(1000).optional().nullable(),
  // IDs explícitos O criterios de filtro (al menos uno debe estar presente)
  prospect_ids: z.array(z.string().uuid()).optional(),
  filters: z.object({
    q:        z.string().max(200).optional(),
    batch_id: z.string().uuid().optional(),
  }).optional(),
}).refine(
  d => (d.prospect_ids && d.prospect_ids.length > 0) || d.filters !== undefined,
  { message: 'Se requieren prospect_ids o filtros para crear la lista' }
)
export type CreateListFromSelectionInput = z.infer<typeof CreateListFromSelectionSchema>

export const PatchWarmupSchema = z.object({
  warmup_status:        z.enum(WARMUP_STATUSES).optional(),
  daily_limit:          z.number().int().min(1).optional(),
  target_days:          z.number().int().min(1).optional(),
  notes:                z.string().max(1000).optional().nullable(),
  display_name:         z.string().max(100).optional(),
  delay_preset:         z.enum(WARMUP_DELAY_PRESETS).optional(),
  anti_ban_enabled:     z.boolean().optional(),
  delay_min_seconds:    z.number().int().min(0).optional(),
  delay_max_seconds:    z.number().int().min(0).optional(),
  sending_window_start: z.string().regex(/^\d{2}:\d{2}$/, 'Formato inválido (HH:MM)').optional(),
  sending_window_end:   z.string().regex(/^\d{2}:\d{2}$/, 'Formato inválido (HH:MM)').optional(),
  active_days:          z.array(z.number().int().min(1).max(7)).optional(),
  randomness_level:     z.enum(WARMUP_RANDOMNESS).optional(),
  natural_distribution: z.boolean().optional(),
})
export type PatchWarmupInput = z.infer<typeof PatchWarmupSchema>
