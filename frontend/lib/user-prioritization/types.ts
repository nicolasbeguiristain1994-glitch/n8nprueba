// Re-exportamos los tipos del dominio desde config para que los consumers
// solo importen desde este módulo (facade).
export type { ReactivationSegment, ValueTier } from './config'

// ── Datos crudos leídos desde contacts ───────────────────────────────────────

export interface ContactMetricsRow {
  contactId:          string
  phoneNumber:        string
  firstName:          string | null
  lastName:           string | null
  status:             string
  segment:            string | null
  lastDepositAt:      Date | null
  totalDeposits:      number          // conteo acumulado (proxy de frecuencia, no de valor)
  totalDepositAmount: number | null   // monto acumulado — NULL hasta migración de datos
  lastDepositAmount:  number | null   // monto del último depósito — NULL hasta migración
  doNotContact:       boolean
  optInMarketing:     boolean
  deletedAt:          Date | null
}

// ── Resultado del cálculo de score para un contacto ──────────────────────────

export interface ScoreBreakdown {
  valueScore:          number   // 0–60
  urgencyScore:        number   // 0–40
  total:               number   // 0–100
  valueTier:           import('./config').ValueTier
  reactivationSegment: import('./config').ReactivationSegment | null
}

// ── Resultado de elegibilidad ─────────────────────────────────────────────────

export interface EligibilityResult {
  eligible:    boolean
  skipReasons: string[]
}

// ── Row persistida en contact_priority_scores ─────────────────────────────────

export interface ContactPriorityScore {
  id:                  string
  contactId:           string
  priorityScore:       number
  reactivationSegment: import('./config').ReactivationSegment | null
  valueTier:           import('./config').ValueTier
  valueScore:          number
  urgencyScore:        number
  daysInactive:        number | null
  depositSegment:      string | null
  totalDepositAmount:  number | null
  isEligible:          boolean
  skipReasons:         string[]
  runId:               string | null   // UUID de la corrida de recompute que calculó este score
  computedAt:          Date
}

// ── DTO público para el listado de operadores ─────────────────────────────────

export interface PrioritizedContact {
  id:                  string
  phoneNumber:         string
  firstName:           string | null
  lastName:            string | null
  segment:             string | null
  platforms:           string[]
  agent:               string | null
  lastDepositAt:       Date | null
  totalDepositAmount:  number | null
  priorityScore:       number
  reactivationSegment: import('./config').ReactivationSegment | null
  valueTier:           import('./config').ValueTier
  daysInactive:        number | null
  daysSinceLastMessage: number | null
  isBroadcasted:       boolean
  broadcastedAt:       Date | null
  broadcastedBy:       string | null
}

// ── Filtros para la consulta de operadores ────────────────────────────────────

export interface PriorityFilters {
  reactivationSegment?: import('./config').ReactivationSegment
  valueTier?:           import('./config').ValueTier
  platform?:            string
  agent?:               string
  broadcasted?:         boolean
  minDaysInactive?:     number
  maxDaysInactive?:     number
  // Consistencia de corrida: por defecto solo muestra el último run completo.
  // includePreviousRuns=true desactiva el filtro (útil para debugging).
  runId?:               string
  includePreviousRuns?: boolean
  page?:                number
  pageSize?:            number
}

// ── Resultado paginado genérico ───────────────────────────────────────────────

export interface PaginatedResult<T> {
  data:       T[]
  total:      number
  page:       number
  pageSize:   number
  totalPages: number
}

// ── Resultado del recompute batch ─────────────────────────────────────────────

export interface RecomputeResult {
  processed:  number
  eligible:   number
  skipped:    number
  durationMs: number
}

// ── Registro de historial de corrida (tabla recompute_runs) ───────────────────

export interface RecomputeRunRecord {
  runId:             string
  startedAt:         Date
  finishedAt:        Date
  status:            'success' | 'failed' | 'revoked'
  contactsProcessed: number
  contactsUpdated:   number   // elegibles (subset de contactsProcessed)
  durationMs:        number
  errorMessage?:     string
  instanceId?:       string
}
