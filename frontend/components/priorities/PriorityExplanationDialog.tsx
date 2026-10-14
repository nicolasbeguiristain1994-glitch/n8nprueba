'use client'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { isFreshCalculation, profileQuality, type PriorityExplanation } from '@/lib/user-prioritization/priority-details'

export const priorityMoney = (value: number | null | undefined) => value == null ? 'Sin datos' : new Intl.NumberFormat('es-AR', {style:'currency',currency:'ARS',maximumFractionDigits:0}).format(value)
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires',dateStyle:'short',timeStyle:'short'}) : 'Sin datos'
export interface ExplainedPriority {
  name: string; level: string; score: number; daysInactive: number | null
  explanation?: PriorityExplanation
}

export function PriorityExplanationDialog({contact,onClose}:{contact:ExplainedPriority|null;onClose:()=>void}) {
  const e=contact?.explanation, p=e?.profile, r=e?.ranking
  return <Dialog open={!!contact} onOpenChange={open=>{if(!open)onClose()}}>
    <DialogContent className="sm:max-w-2xl max-h-[85dvh] overflow-y-auto">
      <DialogHeader><DialogTitle>Detalle de prioridad · {contact?.name}</DialogTitle></DialogHeader>
      {e ? <div className="space-y-5 text-sm">
        <div className="rounded-xl bg-muted p-4">
          <p className="text-lg font-semibold">{contact?.score} puntos = {e.valueScore} de valor + {e.urgencyScore} de urgencia</p>
          <p className="mt-1 text-muted-foreground">Nivel comercial: <strong>{contact?.level}</strong>{e.manualLevel ? ' · asignado manualmente en Contactos' : ' · según el promedio por mes con depósitos y los umbrales de Contactos'}.</p>
          <p className="mt-1 text-muted-foreground">{contact?.daysInactive ?? '—'} días sin depositar. Cálculo: {date(e.calculatedAt)}.</p>
        </div>
        <section className="space-y-2">
          <h3 className="font-semibold">Depósitos e historial</h3>
          <p>{profileQuality(p ?? null)}{p ? ` · datos al ${p.as_of}` : ''}</p>
          {p && (!isFreshCalculation(p.calculated_at) || p.estimated || p.partial_history) && <p className="rounded-lg bg-warning/10 p-3 text-warning">El historial es estimado, parcial o tiene más de 36 horas. Sus ventanas recientes no se usan para desempatar prioridades.</p>}
          <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr className="border-b"><th className="py-2">Período</th><th>Importe</th><th>Cargas</th></tr></thead><tbody>
            <tr><td className="py-2">Últimos 30 días</td><td>{priorityMoney(p?.amount_30d)}</td><td>{p?.deposits_30d ?? 'Sin datos'}</td></tr>
            <tr><td className="py-2">Últimos 90 días</td><td>{priorityMoney(p?.amount_90d)}</td><td>{p?.deposits_90d ?? 'Sin datos'}</td></tr>
            <tr><td className="py-2">Historial registrado</td><td>{priorityMoney(p?.amount)}</td><td>{p?.deposits ?? 'Sin datos'}</td></tr>
          </tbody></table></div>
          <p>Promedio por mes con depósitos: <strong>{priorityMoney(p?.monthly_average)}</strong> · {p?.active_months ?? '—'} meses.</p>
          <p className="text-muted-foreground">Primera carga: {p?.first_date ?? 'Sin datos'} · Última carga: {p?.last_date ?? 'Sin datos'}.</p>
          <p className="text-muted-foreground">Actualización del historial: {date(p?.calculated_at)}. En empates de puntaje se usan importe y cantidad de cargas de 90 días, luego de 30 días.</p>
        </section>
        <section className="space-y-2 border-t pt-4">
          <h3 className="font-semibold">Ranking relativo por cuenta</h3>
          {r ? <><p>Percentil {r.percentile.toLocaleString('es-AR',{maximumFractionDigits:2})} dentro de {r.agent} / {r.platform} · {r.status==='fresh' ? 'Actualizado' : 'Vencido'}.</p>
            <p>Depósitos menos retiros: {priorityMoney(r.net)}. Calculado: {date(r.calculatedAt)}.</p></> : <p>Sin ranking disponible.</p>}
          <p className="text-muted-foreground">Compara depósitos menos retiros con otras cuentas del mismo agente y plataforma. Para varias cuentas se muestra el mayor percentil actualizado. Es informativo: no cambia el nivel comercial, el puntaje ni la elegibilidad.</p>
        </section>
        {p?.accounts?.length ? <section className="border-t pt-4"><h3 className="font-semibold">Cuentas utilizadas</h3><ul className="mt-2 space-y-1">{p.accounts.map((a,i)=><li key={`${a.platform}:${a.username}:${i}`}>{a.username} · {a.platform ?? 'Sin plataforma'} · sincronización {date(a.last_sync_at)}</li>)}</ul></section> : null}
      </div> : <p>No hay un desglose disponible para este cálculo.</p>}
    </DialogContent>
  </Dialog>
}
