import { KanbanBoardHeader } from '@/components/kanban/KanbanBoardHeader'
import { KanbanSkeleton } from '@/components/kanban/KanbanSkeleton'

/**
 * loading.tsx — se muestra automáticamente por Next.js App Router
 * mientras page.tsx resuelve su fetch asíncrono.
 */
export default function PipelineLoading() {
  return (
    <div className="flex flex-col h-full">
      <KanbanBoardHeader />
      <div className="flex-1 overflow-x-auto px-4 pb-4 pt-2">
        <KanbanSkeleton cardsPerColumn={3} />
      </div>
    </div>
  )
}
