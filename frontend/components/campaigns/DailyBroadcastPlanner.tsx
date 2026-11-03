'use client'

import { useEffect, useRef, useState } from 'react'
import { CalendarCheck, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fetchJson } from '@/lib/fetchJson'
import { PLAN_REASON_LABELS, type BroadcastPlan, type BroadcastPlanFilters, type BroadcastPlanOptions } from '@/lib/broadcast-planner'
import type { BroadcastPlanningOptions } from '@/lib/broadcast-plan-repository'

const endpoint = '/api/contacts/prioritized/plan'
const fieldClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm'
const labels: Record<string,string> = {
  REACTIVACION_URGENTE:'Urgente',REACTIVACION_PRIORITARIA:'Prioritaria',REACTIVACION_ESTANDAR:'Estándar',
  REACTIVACION_FRIA_ALTO_VALOR:'Fría alto valor',REACTIVACION_FRIA:'Fría',
}

export function DailyBroadcastPlanner({ filters, onClose }: { filters: BroadcastPlanFilters; onClose: () => void }) {
  const [catalogue,setCatalogue] = useState<BroadcastPlanningOptions | null>(null)
  const [form,setForm] = useState<BroadcastPlanOptions>({ ...filters,lineIds:[],messageType:'template',endTime:'20:00',reservePercent:10,maxContacts:500 })
  const [plan,setPlan] = useState<BroadcastPlan | null>(null)
  const [error,setError] = useState<string | null>(null)
  const [loading,setLoading] = useState(true)
  const [calculating,setCalculating] = useState(false)
  const [tab,setTab] = useState<'selected'|'pending'>('selected')
  const [page,setPage] = useState(1)
  const sequence = useRef(0)

  async function load() {
    const request = ++sequence.current
    setLoading(true);setError(null)
    try {
      const data = await fetchJson<BroadcastPlanningOptions>(endpoint,{cache:'no-store'})
      if (sequence.current !== request) return
      setCatalogue(data)
      setForm(f => ({...f,lineIds:data.lines.map(l => l.id),
        messageType:data.templates.length ? 'template' : 'text',templateId:data.templates[0]?.id}))
    } catch (e) { if (sequence.current === request) setError(e instanceof Error ? e.message : 'No se pudieron cargar las líneas.') }
    finally { if (sequence.current === request) setLoading(false) }
  }
  useEffect(() => { void load(); return () => { sequence.current++ } }, [])

  function update(change: Partial<BroadcastPlanOptions>) {
    setForm(f => ({...f,...change}));setPlan(null);setError(null);setPage(1)
  }
  async function calculate() {
    const request = ++sequence.current
    setCalculating(true);setError(null);setPlan(null)
    try {
      const data = await fetchJson<BroadcastPlan>(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(form)})
      if (sequence.current === request) { setPlan(data);setPage(1);setTab(data.selected ? 'selected' : 'pending') }
    } catch (e) { if (sequence.current === request) setError(e instanceof Error ? e.message : 'No se pudo calcular el plan.') }
    finally { if (sequence.current === request) setCalculating(false) }
  }

  const contacts = plan?.contacts.filter(c => tab === 'selected' ? !c.reason : !!c.reason) ?? []
  const totalPages = Math.max(1,Math.ceil(contacts.length/50))
  const names = new Map(plan?.lines.map(l => [l.id,l.name]) ?? [])
  const groups = new Map<string,number>()
  plan?.contacts.filter(c => !c.reason).forEach(c => groups.set(c.segment ?? 'Sin segmento',(groups.get(c.segment ?? 'Sin segmento') ?? 0)+1))
  const filterText = [filters.platform,filters.agent,filters.valueTier,filters.reactivationSegment && labels[filters.reactivationSegment]].filter(Boolean).join(' · ')

  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="sm:max-w-5xl">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><CalendarCheck size={18}/>Preparar difusión de hoy</DialogTitle>
        <DialogDescription>Calculá una propuesta con los contactos pendientes de tus filtros. Revisar este plan no envía mensajes.</DialogDescription>
      </DialogHeader>
      <p className="text-xs text-muted-foreground">Audiencia: {filterText || 'Todos los contactos pendientes accesibles'} · Incluye todas las páginas.</p>
      {loading && <p role="status" className="flex items-center gap-2"><Loader2 className="animate-spin" size={16}/>Cargando líneas y plantillas…</p>}
      {error && <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
        {error}{!catalogue && !loading && <Button variant="outline" size="sm" className="ml-3" onClick={load}>Reintentar</Button>}
      </div>}
      {catalogue && <>
        <fieldset disabled={calculating} className="space-y-4 disabled:opacity-70">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1 text-xs">Tipo de difusión
              <select aria-label="Tipo de difusión" className={fieldClass} value={form.messageType} onChange={e => update({messageType:e.target.value as 'template'|'text',templateId:e.target.value === 'text' ? undefined : catalogue.templates[0]?.id})}>
                <option value="template">Plantilla · Cloud</option><option value="text">Texto · Evolution</option>
              </select>
            </label>
            <label className="space-y-1 text-xs">Hora de cierre · Argentina
              <input aria-label="Hora de cierre" className={fieldClass} type="time" value={form.endTime} onChange={e => update({endTime:e.target.value})}/>
            </label>
            <label className="space-y-1 text-xs">Reserva para atención (%)
              <input aria-label="Reserva para atención" className={fieldClass} type="number" min={0} max={50} value={form.reservePercent} onChange={e => update({reservePercent:Number(e.target.value)})}/>
            </label>
            <label className="space-y-1 text-xs">Máximo de contactos
              <input aria-label="Máximo de contactos" className={fieldClass} type="number" min={1} max={5000} value={form.maxContacts} onChange={e => update({maxContacts:Number(e.target.value)})}/>
            </label>
          </div>
          {form.messageType === 'template' && <label className="block space-y-1 text-xs">Plantilla aprobada
            <select aria-label="Plantilla aprobada" className={fieldClass} value={form.templateId ?? ''} onChange={e => update({templateId:e.target.value || undefined})}>
              <option value="">Seleccioná una plantilla</option>
              {catalogue.templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            {!catalogue.templates.length && <span className="block text-muted-foreground">No hay plantillas aprobadas para tus líneas Cloud.</span>}
          </label>}
          <div>
            <p className="mb-2 text-xs font-medium">Líneas a evaluar</p>
            <div className="flex flex-wrap gap-2">
              {catalogue.lines.map(line => <label key={line.id} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                <input type="checkbox" checked={form.lineIds.includes(line.id)} onChange={e => update({lineIds:e.target.checked ? [...form.lineIds,line.id] : form.lineIds.filter(id => id !== line.id)})}/>
                {line.name}<span className="text-xs text-muted-foreground">{line.type === 'cloud' ? 'Cloud' : 'Evolution'}</span>
              </label>)}
              {!catalogue.lines.length && <p className="text-sm text-muted-foreground">No tenés líneas disponibles para preparar una difusión.</p>}
            </div>
          </div>
        </fieldset>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">La reserva se calcula sobre el límite diario de cada línea. Se conserva el remitente habitual.</p>
          <Button onClick={calculate} disabled={calculating || !form.lineIds.length || !form.endTime || form.maxContacts<1 || form.maxContacts>5000 || form.reservePercent<0 || form.reservePercent>50 || (form.messageType==='template' && !form.templateId)}>
            {calculating && <Loader2 size={16} className="mr-2 animate-spin"/>}{calculating ? 'Calculando…' : plan ? 'Actualizar plan' : 'Calcular plan'}
          </Button>
        </div>
      </>}
      {plan && <div className="space-y-4 border-t pt-4" aria-label="Resultado del plan">
        <div className="grid grid-cols-3 gap-3">
          {[['Analizados',plan.total],['Seleccionados',plan.selected],['Pendientes',plan.pending]].map(([label,value]) => <div key={label} className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">{label}</p><p className="text-2xl font-semibold tabular-nums">{Number(value).toLocaleString('es-AR')}</p>
          </div>)}
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>Plan calculado: {new Date(plan.generatedAt).toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires',hour12:false})} · Cierre: {new Date(plan.endsAt).toLocaleTimeString('es-AR',{timeZone:'America/Argentina/Buenos_Aires',hour:'2-digit',minute:'2-digit',hour12:false})}</p>
          {plan.computedAt && <p>Prioridades actualizadas: {new Date(plan.computedAt).toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires',hour12:false})}</p>}
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Capacidad y reparto por línea</caption>
            <thead className="bg-muted"><tr>{['Línea','Límite diario','Consumidos','Recomendado restante','Pendientes con línea','Reserva','Cupo estimado','Seleccionados'].map(label => <th key={label} className="p-3 font-medium">{label}</th>)}</tr></thead>
            <tbody>{plan.lines.map(line => <tr key={line.id} className="border-t">
              <td className="p-3"><span className="font-medium">{line.name}</span><p className="text-muted-foreground">{line.hourlyLimit}/hora</p>{line.recommendation && <p className="mt-1 max-w-64 text-muted-foreground">{line.recommendation}</p>}{line.reason && line.reason !== line.recommendation && <p className="mt-1 text-amber-700 dark:text-amber-400">{line.reason}</p>}</td>
              {[line.dailyLimit,line.used,line.recommendedRemaining ?? '—',line.committed,line.reserve,line.capacity,line.selected].map((value,index) => <td key={index} className="p-3 tabular-nums">{value}</td>)}
            </tr>)}</tbody>
          </table>
        </div>
        {!!groups.size && <div className="flex flex-wrap gap-2">{[...groups].map(([segment,count]) => <span key={segment} className="rounded-full bg-success/10 px-3 py-1 text-xs">{labels[segment] ?? segment}: {count}</span>)}</div>}
        {!!plan.reasons.length && <div className="rounded-lg bg-muted p-3 text-sm space-y-1">{plan.reasons.map(r => <p key={r.code}>{r.count} · {r.label}</p>)}</div>}
        <div className="space-y-1 text-xs text-muted-foreground">{plan.warnings.map(w => <p key={w}>{w}</p>)}</div>
        {!plan.total && <p className="py-3 text-center text-sm">No hay contactos pendientes para estos filtros.</p>}
        {!!plan.total && <>
          <div className="flex gap-2">
            <Button size="sm" variant={tab==='selected'?'default':'outline'} onClick={() => {setTab('selected');setPage(1)}}>Ver seleccionados ({plan.selected})</Button>
            <Button size="sm" variant={tab==='pending'?'default':'outline'} onClick={() => {setTab('pending');setPage(1)}}>Ver pendientes ({plan.pending})</Button>
          </div>
          <div className="max-h-72 overflow-auto rounded-lg border">
            <table className="w-full text-left text-xs"><thead className="sticky top-0 bg-muted"><tr>{['Contacto','Puntaje','Segmento','Línea / motivo'].map(label => <th key={label} className="p-3 font-medium">{label}</th>)}</tr></thead>
              <tbody>{contacts.slice((page-1)*50,page*50).map(c => <tr key={c.id} className="border-t">
                <td className="p-3">{c.name || 'Sin nombre'}<p className="text-muted-foreground">{c.phone}</p></td>
                <td className="p-3 tabular-nums">{c.score}</td><td className="p-3">{labels[c.segment ?? ''] ?? '—'}</td>
                <td className="p-3">{c.reason ? PLAN_REASON_LABELS[c.reason] : names.get(c.lineId!)}</td>
              </tr>)}</tbody>
            </table>
            {!contacts.length && <p className="p-4 text-center text-muted-foreground">No hay contactos en este grupo.</p>}
          </div>
          <div className="flex justify-end items-center gap-3 text-xs">
            <Button variant="outline" size="sm" disabled={page<=1} onClick={() => setPage(p => p-1)}>Anterior</Button>
            <span>{page} / {totalPages}</span><Button variant="outline" size="sm" disabled={page>=totalPages} onClick={() => setPage(p => p+1)}>Siguiente</Button>
          </div>
        </>}
      </div>}
    </DialogContent>
  </Dialog>
}
