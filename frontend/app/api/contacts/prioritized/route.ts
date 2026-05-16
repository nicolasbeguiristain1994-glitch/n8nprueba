import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { checkPermissionWithUser } from '@/lib/permissions'
import { parseBody, handleValidationError } from '@/lib/schema'
import { UserPrioritizationService } from '@/lib/user-prioritization/UserPrioritizationService'
import type { ReactivationSegment, ValueTier } from '@/lib/user-prioritization/config'

const service = new UserPrioritizationService()

// Segmentos en orden de prioridad descendente (útil para documentación de la API)
// URGENTE → PRIORITARIA → ESTANDAR → FRIA_ALTO_VALOR → FRIA
const REACTIVATION_SEGMENTS = [
  'REACTIVACION_URGENTE',
  'REACTIVACION_PRIORITARIA',
  'REACTIVACION_ESTANDAR',
  'REACTIVACION_FRIA_ALTO_VALOR',
  'REACTIVACION_FRIA',
] as const

const FilterSchema = z.object({
  // Filtro principal del operador: seleccionar un segmento de difusión específico.
  // Sin filtro → devuelve TODOS los elegibles del último run completo, por priority_score DESC.
  reactivationSegment:  z.enum(REACTIVATION_SEGMENTS).optional(),
  valueTier:            z.enum(['vip', 'alto', 'medio', 'bajo']).optional(),
  platform:             z.string().max(50).optional(),
  minDaysInactive:      z.coerce.number().int().min(0).optional(),
  maxDaysInactive:      z.coerce.number().int().min(0).optional(),
  // true → muestra todos los runs (útil para debugging de corridas fallidas)
  includePreviousRuns:  z.coerce.boolean().default(false),
  page:                 z.coerce.number().int().min(1).default(1),
  pageSize:             z.coerce.number().int().min(1).max(200).default(50),
}).refine(
  d => d.minDaysInactive === undefined || d.maxDaysInactive === undefined || d.minDaysInactive <= d.maxDaysInactive,
  { message: 'minDaysInactive debe ser menor o igual a maxDaysInactive', path: ['minDaysInactive'] },
)

export async function GET(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'contacts', 'read')
  if (!auth.ok) return auth.response

  const params = Object.fromEntries(req.nextUrl.searchParams)
  const parsed = parseBody(FilterSchema, params)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'contacts/prioritized')

  const result = await service.getPrioritizedContacts({
    reactivationSegment: parsed.data.reactivationSegment as ReactivationSegment | undefined,
    valueTier:           parsed.data.valueTier as ValueTier | undefined,
    platform:            parsed.data.platform,
    minDaysInactive:     parsed.data.minDaysInactive,
    maxDaysInactive:     parsed.data.maxDaysInactive,
    includePreviousRuns: parsed.data.includePreviousRuns,
    page:                parsed.data.page,
    pageSize:            parsed.data.pageSize,
  })

  return NextResponse.json(result)
}
