/**
 * task-types.ts — Tipos y schemas de validación para el módulo de Tareas.
 *
 * Incluye:
 *  - Tipos TypeScript discriminados por tipo de tarea
 *  - Schemas Zod para validar `related_data` en backend y frontend
 *  - Helpers de parse y mensajes de error en español
 */

import { z } from 'zod'

// ── Constantes ─────────────────────────────────────────────────────────────────

export const TASK_TYPES     = ['difusion', 'envio_manual', 'calentamiento', 'atencion', 'seguimiento', 'revision', 'otro'] as const
export const TASK_PRIORITIES = ['alta', 'media', 'baja'] as const
export const TASK_STATUSES  = ['pendiente', 'en_progreso', 'completada', 'cancelada'] as const

export type TaskType     = typeof TASK_TYPES[number]
export type TaskPriority = typeof TASK_PRIORITIES[number]
export type TaskStatus   = typeof TASK_STATUSES[number]

// ── Tipos TypeScript por tipo de tarea ────────────────────────────────────────

export type RelatedDataDifusion = {
  type: 'difusion'
  campaign_id?: string   // UUID de la campaña asociada
  list_id?: string       // UUID de la lista de contactos
}

export type RelatedDataEnvioManual = {
  type: 'envio_manual'
  contact_ids?: string[] // UUIDs de contactos específicos
  list_id?: string       // O una lista entera
}

export type RelatedDataCalentamiento = {
  type: 'calentamiento'
  line_ids: string[]     // UUIDs de líneas a calentar (requerido)
}

export type RelatedDataAtencion = {
  type: 'atencion'
  conversation_filters?: {
    status?: string      // 'escalada' | 'activa' | cualquier filtro
    tags?: string[]      // etiquetas de conversation_state
  }
}

export type RelatedDataSeguimiento = {
  type: 'seguimiento'
  contact_id?: string          // UUID del contacto a seguir
  campaign_id?: string         // campaña relacionada
  conversation_phone?: string  // teléfono de la conversación
}

export type RelatedDataRevision = {
  type: 'revision'
  campaign_id?: string  // campaña a revisar
  list_id?: string      // lista a revisar
}

export type RelatedDataOtro = {
  type: 'otro'
  [key: string]: unknown  // libre
}

export type TaskRelatedData =
  | RelatedDataDifusion
  | RelatedDataEnvioManual
  | RelatedDataCalentamiento
  | RelatedDataAtencion
  | RelatedDataSeguimiento
  | RelatedDataRevision
  | RelatedDataOtro

// ── Schemas Zod por tipo ──────────────────────────────────────────────────────

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const zUUID = z.string().regex(uuidRegex, 'Debe ser un UUID válido')

export const relatedDataDifusionSchema = z.object({
  campaign_id: zUUID.optional(),
  list_id:     zUUID.optional(),
}).catchall(z.unknown())

export const relatedDataEnvioManualSchema = z.object({
  contact_ids: z.array(zUUID).max(500, 'Máximo 500 contactos').optional(),
  list_id:     zUUID.optional(),
}).catchall(z.unknown())

export const relatedDataCalentamientoSchema = z.object({
  line_ids: z.array(zUUID)
             .min(1, 'Selecciona al menos una línea para calentar')
             .max(30, 'Máximo 30 líneas'),
}).catchall(z.unknown())

export const relatedDataAtencionSchema = z.object({
  conversation_filters: z.object({
    status: z.string().max(50).optional(),
    tags:   z.array(z.string().max(100)).max(20).optional(),
  }).optional(),
}).catchall(z.unknown())

export const relatedDataSeguimientoSchema = z.object({
  contact_id:          zUUID.optional(),
  campaign_id:         zUUID.optional(),
  conversation_phone:  z.string().max(20).optional(),
}).catchall(z.unknown())

export const relatedDataRevisionSchema = z.object({
  campaign_id: zUUID.optional(),
  list_id:     zUUID.optional(),
}).catchall(z.unknown())

export const relatedDataOtroSchema = z.record(z.string(), z.unknown())

// ── Dispatcher: elegir schema según tipo de tarea ─────────────────────────────

export function getRelatedDataSchema(type: TaskType): z.ZodTypeAny {
  switch (type) {
    case 'difusion':      return relatedDataDifusionSchema
    case 'envio_manual':  return relatedDataEnvioManualSchema
    case 'calentamiento': return relatedDataCalentamientoSchema
    case 'atencion':      return relatedDataAtencionSchema
    case 'seguimiento':   return relatedDataSeguimientoSchema
    case 'revision':      return relatedDataRevisionSchema
    case 'otro':          return relatedDataOtroSchema
    default:              return relatedDataOtroSchema
  }
}

/**
 * Valida `related_data` según el tipo de tarea.
 * Retorna `{ ok: true, data }` o `{ ok: false, error: string }`.
 */
export function validateRelatedData(
  type: TaskType,
  raw: unknown,
): { ok: true; data: TaskRelatedData } | { ok: false; error: string } {
  const schema = getRelatedDataSchema(type)
  const result = schema.safeParse(raw ?? {})
  if (!result.success) {
    const msgs = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    return { ok: false, error: `Datos relacionados inválidos — ${msgs}` }
  }
  return { ok: true, data: result.data as TaskRelatedData }
}

// ── Tipos de UI (frontend) ────────────────────────────────────────────────────

export interface TaskAssignee {
  id: string
  name: string | null
  email: string
}

export interface Task {
  id: string
  title: string
  description: string | null
  type: TaskType
  priority: TaskPriority
  status: TaskStatus
  due_date: string | null
  scheduled_at: string | null
  related_data: Record<string, unknown>
  notes: string | null
  created_by: string | null
  created_by_name: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  completed_by: string | null
  completed_by_name: string | null
  completion_notes: string | null
  cancelled_at: string | null
  cancelled_by: string | null
  cancelled_by_name: string | null
  cancel_reason: string | null
  deleted_at: string | null
  deleted_by: string | null
  assignees: TaskAssignee[]
}

export interface TaskLog {
  id: string
  user_name: string | null
  action: string
  from_status: string | null
  to_status: string | null
  comment: string | null
  created_at: string
}

// ── Labels y colores ──────────────────────────────────────────────────────────

export const TYPE_LABELS: Record<TaskType, string> = {
  difusion:     'Difusión',
  envio_manual: 'Envío manual',
  calentamiento:'Calentamiento',
  atencion:     'Atención',
  seguimiento:  'Seguimiento',
  revision:     'Revisión',
  otro:         'Otro',
}

export const TYPE_COLORS: Record<TaskType, string> = {
  difusion:     'bg-blue-100 text-blue-800',
  envio_manual: 'bg-indigo-100 text-indigo-800',
  calentamiento:'bg-orange-100 text-orange-800',
  atencion:     'bg-teal-100 text-teal-800',
  seguimiento:  'bg-purple-100 text-purple-800',
  revision:     'bg-yellow-100 text-yellow-800',
  otro:         'bg-gray-100 text-gray-700',
}

export const PRIORITY_COLORS: Record<TaskPriority, string> = {
  alta:  'bg-red-100 text-red-700',
  media: 'bg-amber-100 text-amber-700',
  baja:  'bg-green-100 text-green-700',
}

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  alta: 'Alta', media: 'Media', baja: 'Baja',
}

export const STATUS_COLORS: Record<TaskStatus, string> = {
  pendiente:   'bg-slate-100 text-slate-700',
  en_progreso: 'bg-blue-100 text-blue-700',
  completada:  'bg-green-100 text-green-700',
  cancelada:   'bg-red-100 text-red-600',
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  pendiente:   'Pendiente',
  en_progreso: 'En progreso',
  completada:  'Completada',
  cancelada:   'Cancelada',
}

export const LOG_ACTION_LABELS: Record<string, string> = {
  creada:     'Tarea creada',
  asignada:   'Asignación actualizada',
  iniciada:   'Iniciada por operador',
  completada: 'Marcada como completada',
  cancelada:  'Cancelada',
  eliminada:  'Eliminada',
  editada:    'Editada',
  restaurada: 'Restaurada por administrador',
}

// Acceso rápido según tipo de tarea (para vista operador)
export const QUICK_ACCESS: Partial<Record<TaskType, { label: string; href: string }>> = {
  difusion:     { label: 'Ir a Campañas',       href: '/campaigns' },
  envio_manual: { label: 'Ir a Contactos',       href: '/contacts' },
  calentamiento:{ label: 'Ir a Calentamiento',   href: '/warmup' },
  atencion:     { label: 'Ir a Conversaciones',  href: '/conversations' },
  seguimiento:  { label: 'Ir a Conversaciones',  href: '/conversations' },
  revision:     { label: 'Ir a Campañas',        href: '/campaigns' },
}
