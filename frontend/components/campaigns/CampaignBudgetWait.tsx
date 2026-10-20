import { Clock, Loader2, Pause } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function CampaignBudgetWait({ pending, reviewAt, schedulerEnabled, onKeepPaused, busy = false }: {
  pending: number
  reviewAt: string | null
  schedulerEnabled: boolean
  onKeepPaused?: () => void
  busy?: boolean
}) {
  const date = reviewAt ? new Date(reviewAt) : null
  const nextReview = date && Number.isFinite(date.getTime())
    ? `${date.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hourCycle: 'h23' })} (hora Argentina)` : null
  return <section aria-label="Espera por cupo recomendado" className="mt-3 space-y-2 rounded-lg border border-amber-200 bg-amber-50/50 p-3 text-sm">
    <p className="flex items-center gap-2 font-semibold text-amber-800"><Clock size={16} /> Esperando cupo recomendado</p>
    <p>{pending.toLocaleString('es-AR')} destinatarios pendientes. Se conserva la línea habitual de cada cliente.</p>
    <p className="text-xs text-muted-foreground">{schedulerEnabled
      ? `Próxima revisión: ${nextReview ?? 'pendiente de evaluación'}. La campaña continuará solo si vuelve a haber cupo y se cumplen los controles vigentes; esta fecha no garantiza un envío.`
      : 'La revisión automática no está habilitada. Revisá la disponibilidad antes de continuar.'}</p>
    {onKeepPaused && <Button size="sm" variant="outline" onClick={onKeepPaused} disabled={busy}>
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Pause size={13} />} Mantener en pausa
    </Button>}
    {onKeepPaused && <p className="text-xs text-muted-foreground">Mantener en pausa desactiva la continuación automática de esta campaña hasta que la reanudes.</p>}
  </section>
}
