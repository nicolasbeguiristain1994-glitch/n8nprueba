'use client'

import React, { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { KANBAN_COLUMNS } from './types'
import type { Deal, DealStage } from './types'

interface KanbanDealFormProps {
  stage: DealStage
  deal?: Deal
  onSave: (deal: Deal) => void
  onClose: () => void
}

export function KanbanDealForm({ stage, deal, onSave, onClose }: KanbanDealFormProps) {
  const isEdit = Boolean(deal)

  const [title, setTitle]         = useState(deal?.title ?? '')
  const [amount, setAmount]       = useState(deal?.amount != null ? String(deal.amount) : '')
  const [selectedStage, setStage] = useState<DealStage>(deal?.stage ?? stage)
  const [closeDate, setCloseDate] = useState(deal?.close_date ?? '')
  const [notes, setNotes]         = useState(deal?.notes ?? '')
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState('')

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) { setError('El título es requerido'); return }
    setSaving(true)
    setError('')

    try {
      const body = {
        title: title.trim(),
        amount: amount ? Number(amount) : null,
        stage: selectedStage,
        close_date: closeDate || null,
        notes: notes || null,
      }

      if (isEdit && deal) {
        const res = await fetch(`/api/deals/${deal.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error('Error al actualizar')
        onSave({ ...deal, ...body })
      } else {
        const res = await fetch('/api/deals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error('Error al crear')
        const { id } = await res.json()
        onSave({
          id,
          ...body,
          amount: body.amount,
          contact_id: null,
          contact_name: null,
          contact_phone: null,
          owner_id: null,
          owner_name: null,
          position: 999,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido')
    } finally {
      setSaving(false)
    }
  }

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">
            {isEdit ? 'Editar deal' : 'Nuevo deal'}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Title */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">
              Título <span className="text-destructive">*</span>
            </label>
            <input
              autoFocus
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Nombre del deal"
              className={cn(
                'w-full h-9 px-3 rounded-lg border border-input bg-background text-sm',
                'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
                'placeholder:text-muted-foreground',
              )}
            />
          </div>

          {/* Amount + Stage row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Monto (USD)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0"
                className={cn(
                  'w-full h-9 px-3 rounded-lg border border-input bg-background text-sm',
                  'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
                  'placeholder:text-muted-foreground',
                )}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Etapa</label>
              <select
                value={selectedStage}
                onChange={e => setStage(e.target.value as DealStage)}
                className={cn(
                  'w-full h-9 px-3 rounded-lg border border-input bg-background text-sm',
                  'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
                )}
              >
                {KANBAN_COLUMNS.map(col => (
                  <option key={col.id} value={col.id}>{col.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Close date */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Fecha estimada de cierre</label>
            <input
              type="date"
              value={closeDate}
              onChange={e => setCloseDate(e.target.value)}
              className={cn(
                'w-full h-9 px-3 rounded-lg border border-input bg-background text-sm',
                'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
              )}
            />
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Notas</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              placeholder="Observaciones..."
              className={cn(
                'w-full px-3 py-2 rounded-lg border border-input bg-background text-sm resize-none',
                'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
                'placeholder:text-muted-foreground',
              )}
            />
          </div>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-4 rounded-lg text-sm border border-input hover:bg-muted transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className={cn(
                'h-9 px-4 rounded-lg text-sm font-medium',
                'bg-primary text-primary-foreground hover:bg-primary/90 transition-colors',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              {saving ? 'Guardando...' : isEdit ? 'Guardar' : 'Crear deal'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
