import type { BroadcastCampaignDraft } from '@/lib/broadcast-plan-selection'
const format = (value:string) => new Date(value).toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires',hour12:false})
export function BroadcastCampaignSummary({plan,count}:{plan:BroadcastCampaignDraft;count:number}) {
  return <div className="rounded-xl border bg-primary/5 p-4 space-y-2 text-sm" aria-label="Plan de difusión elegido">
    <p className="font-semibold">Plan de difusión · {count.toLocaleString('es-AR')} contactos</p>
    <p>Desde {format(plan.startsAt)} hasta {format(plan.endsAt)} · Argentina</p>
    <ul className="space-y-1">{plan.lines.map(line => <li key={line.id}>{line.name}: {line.selected} contactos</li>)}</ul>
    <a href="/prioridades" className="inline-block text-xs underline">Volver a planificar</a>
    <p className="text-xs text-muted-foreground">Se conserva este reparto y se detiene al cierre. Los contactos sin enviar quedan pendientes para revisar. Para otra fecha o plantilla, volvé a Planificar difusión.</p>
  </div>
}
