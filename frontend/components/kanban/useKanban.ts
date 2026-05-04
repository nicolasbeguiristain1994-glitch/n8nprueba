'use client'

import { useState, useCallback } from 'react'
import type { DragEndEvent, DragStartEvent, DragOverEvent } from '@dnd-kit/core'
import type { Deal, DealStage, DealsByStage } from './types'

interface UseKanbanOptions {
  initialDeals: DealsByStage
  onError?: (msg: string) => void
}

interface UseKanbanReturn {
  deals: DealsByStage
  activeId: number | null
  activeDeal: Deal | null
  handleDragStart: (event: DragStartEvent) => void
  handleDragOver: (event: DragOverEvent) => void
  handleDragEnd: (event: DragEndEvent) => void
  addDeal: (deal: Deal) => void
  removeDeal: (id: number) => void
  updateDeal: (id: number, patch: Partial<Deal>) => void
}

export function useKanban({ initialDeals, onError }: UseKanbanOptions): UseKanbanReturn {
  const [deals, setDeals] = useState<DealsByStage>(initialDeals)
  const [activeId, setActiveId] = useState<number | null>(null)

  const activeDeal: Deal | null = activeId
    ? Object.values(deals).flat().find(d => d.id === activeId) ?? null
    : null

  // ── Drag Start ──────────────────────────────────────────────────────────────
  const handleDragStart = useCallback(({ active }: DragStartEvent) => {
    setActiveId(Number(active.id))
  }, [])

  // ── Drag Over (live column switch) ──────────────────────────────────────────
  const handleDragOver = useCallback(({ active, over }: DragOverEvent) => {
    if (!over) return

    const draggedId = Number(active.id)
    // over.id puede ser un dealId o un columnId (string de DealStage)
    const overId = over.id

    setDeals(prev => {
      // Encontrar la columna origen del deal dragged
      let sourceStage: DealStage | null = null
      for (const stage of Object.keys(prev) as DealStage[]) {
        if (prev[stage].some(d => d.id === draggedId)) {
          sourceStage = stage
          break
        }
      }
      if (!sourceStage) return prev

      // Determinar columna destino
      let destStage: DealStage | null = null
      // Si over.id es un deal, buscar su columna
      if (typeof overId === 'number' || (typeof overId === 'string' && !isNaN(Number(overId)))) {
        const numericId = Number(overId)
        for (const stage of Object.keys(prev) as DealStage[]) {
          if (prev[stage].some(d => d.id === numericId)) {
            destStage = stage
            break
          }
        }
      } else {
        // over.id es el stage string
        destStage = overId as DealStage
      }

      if (!destStage || destStage === sourceStage) return prev

      const dragged = prev[sourceStage].find(d => d.id === draggedId)!
      const newSource = prev[sourceStage].filter(d => d.id !== draggedId)
      const newDest = [...prev[destStage], { ...dragged, stage: destStage }]

      return { ...prev, [sourceStage]: newSource, [destStage]: newDest }
    })
  }, [])

  // ── Drag End (persist) ───────────────────────────────────────────────────────
  const handleDragEnd = useCallback(({ active, over }: DragEndEvent) => {
    const draggedId = Number(active.id)
    setActiveId(null)

    if (!over) return

    // Encontrar el stage final del deal
    setDeals(prev => {
      let finalStage: DealStage | null = null
      let finalPosition = 0
      for (const stage of Object.keys(prev) as DealStage[]) {
        const idx = prev[stage].findIndex(d => d.id === draggedId)
        if (idx !== -1) {
          finalStage = stage
          finalPosition = idx
          break
        }
      }
      if (!finalStage) return prev

      // Persistir al servidor
      fetch(`/api/deals/${draggedId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: finalStage, position: finalPosition }),
      }).catch(() => {
        onError?.('Error al guardar el cambio. Recargando...')
      })

      return prev
    })
  }, [onError])

  // ── CRUD helpers ─────────────────────────────────────────────────────────────
  const addDeal = useCallback((deal: Deal) => {
    setDeals(prev => ({
      ...prev,
      [deal.stage]: [...prev[deal.stage], deal],
    }))
  }, [])

  const removeDeal = useCallback((id: number) => {
    setDeals(prev => {
      const next = { ...prev }
      for (const stage of Object.keys(next) as DealStage[]) {
        next[stage] = next[stage].filter(d => d.id !== id)
      }
      return next
    })
  }, [])

  const updateDeal = useCallback((id: number, patch: Partial<Deal>) => {
    setDeals(prev => {
      const next = { ...prev }
      for (const stage of Object.keys(next) as DealStage[]) {
        const idx = next[stage].findIndex(d => d.id === id)
        if (idx !== -1) {
          const updated = { ...next[stage][idx], ...patch }
          next[stage] = [...next[stage]]
          next[stage][idx] = updated
          return next
        }
      }
      return prev
    })
  }, [])

  return {
    deals,
    activeId,
    activeDeal,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    addDeal,
    removeDeal,
    updateDeal,
  }
}
