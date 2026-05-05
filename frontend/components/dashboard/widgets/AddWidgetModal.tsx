'use client'

import { memo } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Check } from 'lucide-react'
import { WIDGET_REGISTRY, type WidgetId } from '../types'

interface Props {
  open: boolean
  onClose: () => void
  hidden: WidgetId[]
  onToggle: (id: WidgetId) => void
}

export const AddWidgetModal = memo(function AddWidgetModal({ open, onClose, hidden, onToggle }: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md" showCloseButton>
        <DialogHeader>
          <DialogTitle>Personalizar dashboard</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground -mt-1">
          Activa o desactiva widgets. El orden se cambia arrastrando desde el dashboard.
        </p>
        <div className="grid grid-cols-1 gap-2 mt-1">
          {WIDGET_REGISTRY.map(widget => {
            const isVisible = !hidden.includes(widget.id)
            return (
              <button
                key={widget.id}
                onClick={() => onToggle(widget.id)}
                aria-pressed={isVisible}
                className={cn(
                  'flex items-center gap-3 p-3 rounded-lg border text-left transition-all',
                  'hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  isVisible
                    ? 'border-primary/30 bg-primary/5'
                    : 'border-border bg-transparent opacity-60',
                )}
              >
                <div className={cn(
                  'w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-all',
                  isVisible
                    ? 'bg-primary border-primary'
                    : 'border-border',
                )}>
                  {isVisible && <Check className="w-3 h-3 text-primary-foreground" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{widget.label}</p>
                  <p className="text-xs text-muted-foreground">{widget.description}</p>
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {widget.span === 2 ? 'Ancho completo' : 'Medio'}
                </span>
              </button>
            )
          })}
        </div>
        <div className="flex justify-end mt-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
})
