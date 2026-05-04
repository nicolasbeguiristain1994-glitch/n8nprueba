/**
 * DataTable — tests básicos de renderizado y selección.
 *
 * Nota: el DataTable renderiza DOS vistas en el DOM simultáneamente:
 *   - Tabla desktop (hidden en md vía CSS, visible en DOM)
 *   - Mobile cards (hidden en desktop vía CSS, visible en DOM)
 * Por eso usamos getAllByText / within para evitar ambigüedades.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { DataTable } from '../DataTable'
import type { ColumnDef } from '../types'

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
}))

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

interface Row { id: string; name: string; email: string }

const DATA: Row[] = [
  { id: '1', name: 'Ana García',  email: 'ana@example.com' },
  { id: '2', name: 'Luis Pérez',  email: 'luis@example.com' },
  { id: '3', name: 'María López', email: 'maria@example.com' },
]

const COLUMNS: ColumnDef<Row, unknown>[] = [
  { id: 'name',  accessorKey: 'name',  header: 'Nombre' },
  { id: 'email', accessorKey: 'email', header: 'Email'  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Test 1 — Renderizado correcto con datos
// ─────────────────────────────────────────────────────────────────────────────

describe('DataTable — renderizado', () => {
  it('muestra las filas y columnas en la tabla desktop', () => {
    render(
      <DataTable
        data={DATA}
        columns={COLUMNS}
        storageKey="test-render"
      />
    )

    // Scoping a la tabla desktop (grid role)
    const grid = screen.getByRole('grid')

    // Headers de columna en el grid
    expect(within(grid).getAllByText('Nombre').length).toBeGreaterThanOrEqual(1)
    expect(within(grid).getAllByText('Email').length).toBeGreaterThanOrEqual(1)

    // Cada fila de datos aparece al menos una vez en el DOM total
    expect(screen.getAllByText('Ana García').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Luis Pérez').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('María López').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('ana@example.com').length).toBeGreaterThanOrEqual(1)
  })

  it('muestra el empty state cuando no hay datos', () => {
    render(
      <DataTable
        data={[]}
        columns={COLUMNS}
        storageKey="test-empty"
      />
    )

    expect(screen.getByText('Sin resultados')).toBeInTheDocument()
  })

  it('muestra skeleton cuando loading=true', () => {
    render(
      <DataTable
        data={[]}
        columns={COLUMNS}
        loading
        storageKey="test-loading"
      />
    )

    // El skeleton renderiza filas con aria-hidden="true"
    const skeletonRows = document.querySelectorAll('tr[aria-hidden="true"]')
    expect(skeletonRows.length).toBeGreaterThan(0)
  })

  it('no muestra filas de datos cuando está en loading', () => {
    render(
      <DataTable
        data={DATA}
        columns={COLUMNS}
        loading
        storageKey="test-loading-data"
      />
    )

    // Con loading, solo se muestran skeletons — no el contenido de los datos
    expect(screen.queryByText('Ana García')).not.toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Test 2 — Selección de filas y bulk actions
// ─────────────────────────────────────────────────────────────────────────────

describe('DataTable — selección y bulk actions', () => {
  it('no muestra bulk actions cuando no hay selección', () => {
    const bulkActions = vi.fn((ids: string[]) => (
      <div data-testid="bulk-bar">{ids.length} seleccionados</div>
    ))

    render(
      <DataTable
        data={DATA}
        columns={COLUMNS}
        storageKey="test-no-selection"
        getRowId={(row) => row.id}
        rowSelection={{}}
        onRowSelectionChange={vi.fn()}
        bulkActions={bulkActions}
      />
    )

    expect(screen.queryByTestId('bulk-bar')).not.toBeInTheDocument()
  })

  it('muestra bulk actions cuando hay filas seleccionadas', () => {
    const bulkActions = vi.fn((ids: string[]) => (
      <div data-testid="bulk-bar">{ids.length} seleccionados</div>
    ))

    render(
      <DataTable
        data={DATA}
        columns={COLUMNS}
        storageKey="test-with-selection"
        getRowId={(row) => row.id}
        rowSelection={{ '1': true, '2': true }}
        onRowSelectionChange={vi.fn()}
        bulkActions={bulkActions}
      />
    )

    expect(screen.getByTestId('bulk-bar')).toBeInTheDocument()
    expect(screen.getByText('2 seleccionados')).toBeInTheDocument()

    // bulkActions debe recibir exactamente los IDs seleccionados
    expect(bulkActions).toHaveBeenCalledWith(['1', '2'])
  })

  it('llama onRowSelectionChange al interactuar con el checkbox de header', () => {
    const handleSelectionChange = vi.fn()

    render(
      <DataTable
        data={DATA}
        columns={COLUMNS}
        storageKey="test-header-checkbox"
        getRowId={(row) => row.id}
        rowSelection={{}}
        onRowSelectionChange={handleSelectionChange}
      />
    )

    // El checkbox del header está en la tabla (grid)
    const headerCheckbox = screen.getByLabelText('Seleccionar todas las filas de esta página')
    expect(headerCheckbox).toBeInTheDocument()

    fireEvent.click(headerCheckbox)

    expect(handleSelectionChange).toHaveBeenCalledTimes(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Test 3 — Persistencia de densidad en localStorage
// ─────────────────────────────────────────────────────────────────────────────

describe('DataTable — persistencia', () => {
  it('persiste la densidad seleccionada en localStorage', () => {
    render(
      <DataTable
        data={DATA}
        columns={COLUMNS}
        storageKey="test-density"
      />
    )

    // Abrir menú de densidad
    const densityBtn = screen.getByLabelText('Cambiar densidad de filas')
    fireEvent.click(densityBtn)

    // Menú visible
    const menu = screen.getByRole('menu', { name: 'Densidad de filas' })
    expect(menu).toBeInTheDocument()

    // Seleccionar "Compacto"
    const compactOption = within(menu).getByText('Compacto')
    fireEvent.click(compactOption)

    // Verificar que se guardó en localStorage
    expect(localStorage.getItem('test-density:density')).toBe('"compact"')
  })

  it('lee la densidad persistida al montar', () => {
    // Pre-cargar localStorage
    localStorage.setItem('test-persist:density', '"comfortable"')

    render(
      <DataTable
        data={DATA}
        columns={COLUMNS}
        storageKey="test-persist"
      />
    )

    // El toolbar debe mostrar el label de la densidad persistida
    expect(screen.getByText('Cómodo')).toBeInTheDocument()
  })
})
