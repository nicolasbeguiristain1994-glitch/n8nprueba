export type DealStage =
  | 'calificado'
  | 'propuesta'
  | 'negociacion'
  | 'cierre'
  | 'ganado'
  | 'perdido'

export interface Deal {
  id: number
  title: string
  amount: number | null
  stage: DealStage
  contact_id: number | null
  contact_name: string | null
  contact_phone: string | null
  owner_id: number | null
  owner_name: string | null
  close_date: string | null
  notes: string | null
  position: number
  created_at: string
  updated_at: string
}

export interface KanbanColumnConfig {
  id: DealStage
  label: string
  color: string          // Tailwind bg class for the dot
  headerClass: string    // Tailwind classes for column header accent
}

export const KANBAN_COLUMNS: KanbanColumnConfig[] = [
  { id: 'calificado',   label: 'Calificado',   color: 'bg-blue-400',   headerClass: 'border-t-blue-400'   },
  { id: 'propuesta',    label: 'Propuesta',    color: 'bg-violet-400', headerClass: 'border-t-violet-400' },
  { id: 'negociacion',  label: 'Negociación',  color: 'bg-amber-400',  headerClass: 'border-t-amber-400'  },
  { id: 'cierre',       label: 'Cierre',       color: 'bg-orange-400', headerClass: 'border-t-orange-400' },
  { id: 'ganado',       label: 'Ganado',       color: 'bg-emerald-400',headerClass: 'border-t-emerald-400'},
  { id: 'perdido',      label: 'Perdido',      color: 'bg-rose-400',   headerClass: 'border-t-rose-400'   },
]

export type DealsByStage = Record<DealStage, Deal[]>
