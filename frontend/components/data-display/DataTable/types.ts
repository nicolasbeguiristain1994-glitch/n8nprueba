/**
 * types.ts — tipos centrales del sistema DataTable.
 *
 * Diseño de API:
 *   - Genérico en TData para reutilizar con cualquier entidad (Contactos, Campañas, etc.)
 *   - Soporta modo paginated (default, compatible con server-side) y virtual (client-side, 5000+ filas)
 *   - Toolbar, bulkActions y rowActions son slots externos para máxima flexibilidad
 */

import type {
  ColumnDef,
  PaginationState,
  RowSelectionState,
  SortingState,
  VisibilityState,
} from '@tanstack/react-table'

// ─────────────────────────────────────────────────────────────────────────────
// Re-export tipos de TanStack para que los consumers no importen directamente
// ─────────────────────────────────────────────────────────────────────────────
export type {
  ColumnDef,
  PaginationState,
  RowSelectionState,
  SortingState,
  VisibilityState,
}

// ─────────────────────────────────────────────────────────────────────────────
// Density
// ─────────────────────────────────────────────────────────────────────────────

export type Density = 'compact' | 'normal' | 'comfortable'

/** Clases de padding vertical por densidad */
export const DENSITY_ROW_CLASS: Record<Density, string> = {
  compact:     'py-1',
  normal:      'py-2.5',
  comfortable: 'py-4',
}

export const DENSITY_LABELS: Record<Density, string> = {
  compact:     'Compacto',
  normal:      'Normal',
  comfortable: 'Cómodo',
}

// ─────────────────────────────────────────────────────────────────────────────
// Props principales del DataTable
// ─────────────────────────────────────────────────────────────────────────────

export interface DataTableProps<TData> {
  /** Filas a mostrar (página actual en modo server-side) */
  data: TData[]
  /** Definición de columnas — usar useMemo en el parent */
  columns: ColumnDef<TData, unknown>[]
  /** Muestra skeleton mientras se carga */
  loading?: boolean

  // ── Paginación ────────────────────────────────────────────────────────────
  /**
   * true → paginación manual (server-side).
   * El parent controla pagination y onPaginationChange.
   */
  manualPagination?: boolean
  /** Total de páginas (requerido en manualPagination) */
  pageCount?: number
  /** Estado de paginación (controlado) */
  pagination?: PaginationState
  onPaginationChange?: (pagination: PaginationState) => void

  // ── Sorting ───────────────────────────────────────────────────────────────
  /** true → sorting manual (server-side) */
  manualSorting?: boolean
  sorting?: SortingState
  onSortingChange?: (sorting: SortingState) => void

  // ── Selección ────────────────────────────────────────────────────────────
  rowSelection?: RowSelectionState
  onRowSelectionChange?: (selection: RowSelectionState) => void
  /** Función para extraer el ID único de cada fila */
  getRowId?: (row: TData) => string

  // ── Slots UI ─────────────────────────────────────────────────────────────
  /**
   * Barra de acciones visibles solo cuando hay filas seleccionadas.
   * Recibe los IDs seleccionados para lanzar acciones bulk.
   */
  bulkActions?: (selectedIds: string[]) => React.ReactNode
  /**
   * Acciones por fila (hover actions).
   * Recibe la fila y devuelve los botones a mostrar.
   */
  rowActions?: (row: TData) => React.ReactNode
  /** Slot para filtros/búsqueda adicionales encima de la tabla */
  toolbar?: React.ReactNode
  /** Callback al hacer click en una fila */
  onRowClick?: (row: TData) => void
  /**
   * Estado vacío custom. Si no se provee, se usa DataTableEmptyState genérico.
   */
  emptyState?: React.ReactNode

  // ── Persistencia ─────────────────────────────────────────────────────────
  /**
   * Prefijo para las claves de localStorage (density, column visibility).
   * Usar un identificador único por entidad, ej: 'contacts', 'campaigns'.
   */
  storageKey?: string

  // ── Virtualización ───────────────────────────────────────────────────────
  /**
   * true → activa @tanstack/react-virtual (sin paginación).
   * Ideal para listas client-side de 5000+ filas.
   * false (default) → paginación estándar.
   */
  virtual?: boolean
}
