'use client'

import { Kanban } from 'lucide-react'

export function KanbanBoardHeader() {
  return (
    <div className="flex items-center gap-3 px-4 pt-4 pb-2 border-b border-border shrink-0">
      <div className="flex items-center gap-2.5">
        <Kanban size={20} className="text-primary" />
        <div>
          <h1 className="text-lg font-semibold text-foreground leading-none">Pipeline</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Gestión de deals por etapa</p>
        </div>
      </div>
    </div>
  )
}
