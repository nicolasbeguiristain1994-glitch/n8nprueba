import { KanbanBoard } from '@/components/kanban/KanbanBoard'
import { KanbanBoardHeader } from '@/components/kanban/KanbanBoardHeader'
import type { DealsByStage, DealStage } from '@/components/kanban/types'

const STAGES: DealStage[] = ['calificado','propuesta','negociacion','cierre','ganado','perdido']

async function fetchDeals(): Promise<DealsByStage> {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  try {
    const res = await fetch(`${base}/api/deals`, {
      cache: 'no-store',
      headers: { 'x-internal-request': '1' },
    })
    if (!res.ok) throw new Error('fetch failed')
    return res.json()
  } catch {
    // Devolver estructura vacía si falla
    return Object.fromEntries(STAGES.map(s => [s, []])) as unknown as DealsByStage
  }
}

export default async function PipelinePage() {
  const initialDeals = await fetchDeals()

  return (
    <div className="flex flex-col h-full">
      <KanbanBoardHeader />
      <div className="flex-1 overflow-x-auto px-4 pb-4 pt-2">
        <KanbanBoard initialDeals={initialDeals} />
      </div>
    </div>
  )
}

export const metadata = { title: 'Pipeline | WA Platform' }
