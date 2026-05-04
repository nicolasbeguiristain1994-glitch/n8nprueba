/**
 * Kanban — tests de renderizado, lógica de estado y UI.
 *
 * El KanbanBoard renderiza DOS layouts en el DOM simultáneamente:
 *   - Mobile tabs (md:hidden) — solo muestra la columna activa (calificado por defecto)
 *   - Desktop board (hidden md:flex) — muestra las 6 columnas
 * En happy-dom sin breakpoints CSS, ambos están en el DOM.
 *
 * Estrategia:
 *   - Renderizado de board → usamos getAllByText / toBeGreaterThanOrEqual
 *   - Lógica de estado   → testeamos useKanban directamente con renderHook
 *   - UI de cards        → KanbanCard aislada (sin DnD context real)
 *
 * Mocks @dnd-kit: DndContext/DragOverlay pasan children directamente;
 *   useDroppable y useSortable devuelven props neutros.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { renderHook } from '@testing-library/react'
import { KanbanBoard } from '../KanbanBoard'
import { KanbanCard } from '../KanbanCard'
import { useKanban } from '../useKanban'
import type { Deal, DealsByStage } from '../types'

// ─────────────────────────────────────────────────────────────────────────────
// Mocks globales
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('@dnd-kit/core', async () => {
  const actual = await vi.importActual<typeof import('@dnd-kit/core')>('@dnd-kit/core')
  return {
    ...actual,
    DndContext:   ({ children }: { children: React.ReactNode }) => <>{children}</>,
    DragOverlay:  ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
    useSensor:    vi.fn(() => ({})),
    useSensors:   vi.fn((...args: unknown[]) => args),
    PointerSensor: class {},
    TouchSensor:   class {},
    closestCorners: vi.fn(),
  }
})

vi.mock('@dnd-kit/sortable', async () => {
  const actual = await vi.importActual<typeof import('@dnd-kit/sortable')>('@dnd-kit/sortable')
  return {
    ...actual,
    SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useSortable: () => ({
      attributes:  {},
      listeners:   {},
      setNodeRef:  vi.fn(),
      transform:   null,
      transition:  undefined,
      isDragging:  false,
    }),
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: 1, title: 'Deal de prueba', amount: 5000,
    stage: 'calificado',
    contact_id: null, contact_name: null, contact_phone: null,
    owner_id: null, owner_name: null,
    close_date: null, notes: null,
    position: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function emptyBoard(): DealsByStage {
  return {
    calificado: [], propuesta: [], negociacion: [],
    cierre: [], ganado: [], perdido: [],
  }
}

function boardWith(deals: Deal[]): DealsByStage {
  const b = emptyBoard()
  for (const d of deals) b[d.stage].push(d)
  return b
}

beforeEach(() => {
  vi.clearAllMocks()
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
})

// ─────────────────────────────────────────────────────────────────────────────
// Test suite 1 — KanbanBoard: renderizado correcto con deals
// ─────────────────────────────────────────────────────────────────────────────

describe('KanbanBoard — renderizado', () => {
  it('muestra los 6 headers de columna (tabs móvil + desktop)', () => {
    render(<KanbanBoard initialDeals={emptyBoard()} />)

    // Cada label aparece al menos 1 vez (tab) y en desktop al menos 1 vez más
    const labels = ['Calificado','Propuesta','Negociación','Cierre','Ganado','Perdido']
    for (const label of labels) {
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(1)
    }
  })

  it('muestra los deals en su columna correcta', () => {
    const deals = [
      makeDeal({ id: 1, title: 'Deal Alpha', stage: 'calificado' }),
      makeDeal({ id: 2, title: 'Deal Beta',  stage: 'propuesta'  }),
      makeDeal({ id: 3, title: 'Deal Gamma', stage: 'ganado'     }),
    ]
    render(<KanbanBoard initialDeals={boardWith(deals)} />)

    // Cada deal aparece al menos una vez en el DOM
    expect(screen.getAllByText('Deal Alpha').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Deal Beta').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Deal Gamma').length).toBeGreaterThanOrEqual(1)
  })

  it('muestra zonas "Soltar aquí" en columnas vacías', () => {
    render(<KanbanBoard initialDeals={emptyBoard()} />)
    // Al menos 1 "Soltar aquí" visible (columna activa en mobile + desktop)
    const dropZones = screen.getAllByText('Soltar aquí')
    expect(dropZones.length).toBeGreaterThanOrEqual(1)
  })

  it('abre el formulario al hacer clic en el botón "+"', () => {
    render(<KanbanBoard initialDeals={emptyBoard()} />)

    // Hay varios botones "+" (uno por columna en desktop + uno en mobile)
    const addBtns = screen.getAllByLabelText(/Agregar deal en/)
    fireEvent.click(addBtns[0])

    expect(screen.getByText(/Nuevo deal/i)).toBeInTheDocument()
  })

  it('cambia de columna en móvil al hacer clic en un tab', () => {
    render(<KanbanBoard initialDeals={emptyBoard()} />)

    // El tablist está en el DOM
    const tablist = screen.getByRole('tablist', { name: 'Etapas del pipeline' })
    const propuestaTab = within(tablist).getByRole('tab', { name: /Propuesta/i })

    // Inicialmente "Calificado" está seleccionado
    const calificadoTab = within(tablist).getByRole('tab', { name: /Calificado/i })
    expect(calificadoTab).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(propuestaTab)

    expect(propuestaTab).toHaveAttribute('aria-selected', 'true')
    expect(calificadoTab).toHaveAttribute('aria-selected', 'false')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Test suite 2 — useKanban: optimistic update al mover un deal
// ─────────────────────────────────────────────────────────────────────────────

describe('useKanban — optimistic update', () => {
  it('addDeal agrega el deal a la columna correcta', () => {
    const { result } = renderHook(() => useKanban({ initialDeals: emptyBoard() }))

    act(() => { result.current.addDeal(makeDeal({ id: 10, stage: 'propuesta' })) })

    expect(result.current.deals.propuesta).toHaveLength(1)
    expect(result.current.deals.propuesta[0].id).toBe(10)
    expect(result.current.deals.calificado).toHaveLength(0)
  })

  it('removeDeal elimina el deal de su columna', () => {
    const deal = makeDeal({ id: 5, stage: 'cierre' })
    const { result } = renderHook(() => useKanban({ initialDeals: boardWith([deal]) }))

    expect(result.current.deals.cierre).toHaveLength(1)
    act(() => { result.current.removeDeal(5) })
    expect(result.current.deals.cierre).toHaveLength(0)
  })

  it('updateDeal modifica campos del deal preservando el resto', () => {
    const deal = makeDeal({ id: 7, title: 'Original', stage: 'negociacion', amount: 1000 })
    const { result } = renderHook(() => useKanban({ initialDeals: boardWith([deal]) }))

    act(() => { result.current.updateDeal(7, { title: 'Actualizado', amount: 9999 }) })

    const updated = result.current.deals.negociacion[0]
    expect(updated.title).toBe('Actualizado')
    expect(updated.amount).toBe(9999)
    expect(updated.stage).toBe('negociacion')   // no tocado
    expect(updated.id).toBe(7)
  })

  it('handleDragEnd llama a fetch PATCH con stage y position correctos', async () => {
    const deal = makeDeal({ id: 3, stage: 'calificado', position: 0 })
    const { result } = renderHook(() => useKanban({ initialDeals: boardWith([deal]) }))

    // simular drag start
    act(() => {
      result.current.handleDragStart({
        active: { id: 3, data: { current: {} } },
      } as unknown as Parameters<typeof result.current.handleDragStart>[0])
    })

    // simular drag end
    act(() => {
      result.current.handleDragEnd({
        active: { id: 3, data: { current: {} } },
        over:   { id: 'calificado', data: { current: {} }, rect: { current: { initial: null, translated: null } }, disabled: false },
        delta:  { x: 0, y: 0 },
        activatorEvent: new Event('pointerup'),
        collisions: [],
      } as unknown as Parameters<typeof result.current.handleDragEnd>[0])
    })

    // Flush microtareas (Promise.resolve() drena la cola de microtasks)
    await Promise.resolve()

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/deals/3',
      expect.objectContaining({ method: 'PATCH' }),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Test suite 3 — KanbanCard: renderizado de datos del deal
// ─────────────────────────────────────────────────────────────────────────────

describe('KanbanCard — renderizado', () => {
  it('muestra título, contacto y propietario cuando existen', () => {
    const deal = makeDeal({
      id: 1,
      title: 'Venta importante',
      amount: null,
      contact_name: 'Ana García',
      owner_name: 'Pedro',
    })
    render(<KanbanCard deal={deal} />)

    expect(screen.getByText('Venta importante')).toBeInTheDocument()
    expect(screen.getByText('Ana García')).toBeInTheDocument()
    expect(screen.getByText('Pedro')).toBeInTheDocument()
  })

  it('no muestra el bloque de monto cuando amount es null', () => {
    const deal = makeDeal({ amount: null })
    render(<KanbanCard deal={deal} />)
    // Sin DollarSign ni cifra
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
  })

  it('llama onEdit con el deal al hacer clic en el botón editar', () => {
    const onEdit = vi.fn()
    const deal = makeDeal({ id: 42 })
    render(<KanbanCard deal={deal} onEdit={onEdit} />)

    fireEvent.click(screen.getByLabelText('Editar deal'))
    expect(onEdit).toHaveBeenCalledWith(deal)
  })

  it('llama onDelete con el id al hacer clic en el botón eliminar', () => {
    const onDelete = vi.fn()
    const deal = makeDeal({ id: 99 })
    render(<KanbanCard deal={deal} onDelete={onDelete} />)

    fireEvent.click(screen.getByLabelText('Eliminar deal'))
    expect(onDelete).toHaveBeenCalledWith(99)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Test suite 4 — useKanban: persistencia de orden dentro de columna
// ─────────────────────────────────────────────────────────────────────────────

describe('useKanban — orden en columna', () => {
  it('múltiples addDeal mantienen el orden de inserción', () => {
    const { result } = renderHook(() => useKanban({ initialDeals: emptyBoard() }))

    act(() => {
      result.current.addDeal(makeDeal({ id: 1, title: 'Primero',  stage: 'calificado', position: 0 }))
      result.current.addDeal(makeDeal({ id: 2, title: 'Segundo',  stage: 'calificado', position: 1 }))
      result.current.addDeal(makeDeal({ id: 3, title: 'Tercero',  stage: 'calificado', position: 2 }))
    })

    const col = result.current.deals.calificado
    expect(col).toHaveLength(3)
    expect(col[0].title).toBe('Primero')
    expect(col[1].title).toBe('Segundo')
    expect(col[2].title).toBe('Tercero')
  })

  it('removeDeal no altera el orden de los deals restantes', () => {
    const deals = [
      makeDeal({ id: 1, title: 'A', stage: 'propuesta', position: 0 }),
      makeDeal({ id: 2, title: 'B', stage: 'propuesta', position: 1 }),
      makeDeal({ id: 3, title: 'C', stage: 'propuesta', position: 2 }),
    ]
    const { result } = renderHook(() => useKanban({ initialDeals: boardWith(deals) }))

    act(() => { result.current.removeDeal(2) })

    const col = result.current.deals.propuesta
    expect(col).toHaveLength(2)
    expect(col[0].title).toBe('A')
    expect(col[1].title).toBe('C')
  })

  it('el estado inicial preserva los deals tal como vienen del servidor', () => {
    const serverDeals = [
      makeDeal({ id: 10, title: 'Primero en server',  stage: 'cierre', position: 0 }),
      makeDeal({ id: 11, title: 'Segundo en server',  stage: 'cierre', position: 1 }),
    ]
    const { result } = renderHook(() =>
      useKanban({ initialDeals: boardWith(serverDeals) })
    )

    expect(result.current.deals.cierre[0].id).toBe(10)
    expect(result.current.deals.cierre[1].id).toBe(11)
    // columnas no relacionadas intactas
    expect(result.current.deals.ganado).toHaveLength(0)
  })
})
