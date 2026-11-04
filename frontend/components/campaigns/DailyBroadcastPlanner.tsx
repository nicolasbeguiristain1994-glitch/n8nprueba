'use client'

import { useEffect, useRef, useState } from 'react'
import { CalendarCheck, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fetchJson } from '@/lib/fetchJson'
import { agentScope } from '@/lib/agent-scope'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { saveCampaignSelection } from '@/lib/campaign-selection-draft'
import { campaignDraftFromPlan, lineCompatibility } from '@/lib/broadcast-plan-selection'
import { PLAN_REASON_LABELS, PLAN_REASON_ACTIONS, planContactGroup, type BroadcastPlan, type BroadcastPlanFilters, type BroadcastPlanOptions } from '@/lib/broadcast-planner'
import type { BroadcastPlanningOptions } from '@/lib/broadcast-plan-repository'

const endpoint = '/api/contacts/prioritized/plan'
const fieldClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm'
const labels: Record<string,string> = {
  REACTIVACION_URGENTE:'Urgente',REACTIVACION_PRIORITARIA:'Prioritaria',REACTIVACION_ESTANDAR:'Estándar',
  REACTIVACION_FRIA_ALTO_VALOR:'Fría alto valor',REACTIVACION_FRIA:'Fría',
}

export function DailyBroadcastPlanner({ filters, onClose }: { filters: BroadcastPlanFilters; onClose: () => void }) {
  const {user,permissions} = useCurrentUser()
  const canCreateCampaign = user?.role === 'admin' || (!!permissions?.contacts?.includes('read') && !!permissions?.campaigns?.includes('read'))
  const [catalogue,setCatalogue] = useState<BroadcastPlanningOptions | null>(null)
  const [form,setForm] = useState<BroadcastPlanOptions>({ ...filters,lineIds:[],messageType:'template',planDate:'',startTime:'09:00',endTime:'20:00',reservePercent:10,maxContacts:500 })
  const [plan,setPlan] = useState<BroadcastPlan | null>(null)
  const [error,setError] = useState<string | null>(null)
  const [loading,setLoading] = useState(true)
  const [calculating,setCalculating] = useState(false)
  const [tab,setTab] = useState<'selected'|'pending'|'excluded'>('selected')
  const [page,setPage] = useState(1)
  const sequence = useRef(0)

  async function load() {
    const request = ++sequence.current
    setLoading(true);setError(null)
    try {
      const data = await fetchJson<BroadcastPlanningOptions>(endpoint,{cache:'no-store'})
      if (sequence.current !== request) return
      setCatalogue(data)
      const suggested = [...data.templates].sort((a,b) =>
        data.lines.filter(l => !lineCompatibility(l,{messageType:'template',templateId:b.id},data.templates)).length -
        data.lines.filter(l => !lineCompatibility(l,{messageType:'template',templateId:a.id},data.templates)).length)[0]
      const template = suggested && (data.lines.some(l => !lineCompatibility(l,{messageType:'template',templateId:suggested.id},data.templates)) || !data.lines.some(l => !lineCompatibility(l,{messageType:'text'},data.templates))) ? suggested : undefined
      const content = {messageType:template ? 'template' as const : 'text' as const,templateId:template?.id}
      setForm(f => ({...f,...content,planDate:data.days[0].date,
        lineIds:data.lines.filter(l => !lineCompatibility(l,content,data.templates)).map(l => l.id)}))
    } catch (e) { if (sequence.current === request) setError(e instanceof Error ? e.message : 'No se pudieron cargar las líneas.') }
    finally { if (sequence.current === request) setLoading(false) }
  }
  useEffect(() => { void load(); return () => { sequence.current++ } }, [])

  function update(change: Partial<BroadcastPlanOptions>) {
    setForm(f => {
      const next = {...f,...change}
      if (catalogue && ('messageType' in change || 'templateId' in change))
        next.lineIds = catalogue.lines.filter(l => !lineCompatibility(l,next,catalogue.templates)).map(l => l.id)
      return next
    });setPlan(null);setError(null);setPage(1)
  }
  async function calculate() {
    const request = ++sequence.current
    setCalculating(true);setError(null);setPlan(null)
    try {
      const data = await fetchJson<BroadcastPlan>(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(form)})
      if (sequence.current === request) { setPlan(data);setPage(1);setTab(data.selected ? 'selected' : data.pending ? 'pending' : 'excluded') }
    } catch (e) { if (sequence.current === request) setError(e instanceof Error ? e.message : 'No se pudo calcular el plan.') }
    finally { if (sequence.current === request) setCalculating(false) }
  }

  function createFromPlan() {
    if (!plan || !user?.id) return
    try {
      const draft = campaignDraftFromPlan(plan,form)
      if (agentScope(user) !== null && !draft.agentKey) throw Error('Para crear esta campaña, elegí un único agente en los filtros de Prioridades y volvé a calcular el plan.')
      const token = saveCampaignSelection(user.id,plan.contacts.filter(c => !c.reason).map(c => c.id),sessionStorage,draft)
      window.location.assign(`/campaigns?selection=${encodeURIComponent(token)}`)
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo trasladar el plan. Intentá nuevamente.') }
  }
  const contacts = plan?.contacts.filter(c => planContactGroup(c.reason) === tab) ?? []
  const totalPages = Math.max(1,Math.ceil(contacts.length/50))
  const names = new Map(plan?.lines.map(l => [l.id,l.name]) ?? [])
  const groups = new Map<string,number>()
  plan?.contacts.filter(c => !c.reason).forEach(c => groups.set(c.segment ?? 'Sin segmento',(groups.get(c.segment ?? 'Sin segmento') ?? 0)+1))
  const filterText = [filters.platform,filters.agent,filters.valueTier,filters.reactivationSegment && labels[filters.reactivationSegment]].filter(Boolean).join(' · ')

  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="sm:max-w-5xl">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><CalendarCheck size={18}/>Planificar difusión</DialogTitle>
        <DialogDescription>Calculá una propuesta con los contactos pendientes de tus filtros. Revisar este plan no envía mensajes.</DialogDescription>
      </DialogHeader>
      <p className="text-xs text-muted-foreground">Audiencia: {filterText || 'Todos los contactos pendientes accesibles'} · Incluye todas las páginas.</p>
      {loading && <p role="status" className="flex items-center gap-2"><Loader2 className="animate-spin" size={16}/>Cargando líneas y plantillas…</p>}
      {error && <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
        {error}{!catalogue && !loading && <Button variant="outline" size="sm" className="ml-3" onClick={load}>Reintentar</Button>}
      </div>}
      {catalogue && <>
        <fieldset disabled={calculating} className="space-y-4 disabled:opacity-70">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="space-y-1 text-xs">Día de difusión · Argentina
              <select aria-label="Día de difusión" className={fieldClass} value={form.planDate} onChange={e => update({planDate:e.target.value})}>
                {catalogue.days.map(day => <option key={day.date} value={day.date}>{day.label} · {day.date.split('-').reverse().join('/')}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-xs">Hora de inicio · Argentina
              <input aria-label="Hora de inicio" className={fieldClass} type="time" value={form.startTime} onChange={e => update({startTime:e.target.value})}/>
            </label>
            <label className="space-y-1 text-xs">Hora de cierre · Argentina
              <input aria-label="Hora de cierre" className={fieldClass} type="time" value={form.endTime} onChange={e => update({endTime:e.target.value})}/>
            </label>
            <label className="space-y-1 text-xs">Tipo de difusión
              <select aria-label="Tipo de difusión" className={fieldClass} value={form.messageType} onChange={e => update({messageType:e.target.value as 'template'|'text',templateId:e.target.value === 'text' ? undefined : catalogue.templates[0]?.id})}>
                <option value="template">Plantilla · Cloud</option><option value="text">Texto · Evolution</option>
              </select>
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
              {catalogue.templates.map(t => { const count=catalogue.lines.filter(l => !lineCompatibility(l,{messageType:'template',templateId:t.id},catalogue.templates)).length; return <option key={t.id} value={t.id}>{t.name} · {count} {count===1 ? 'línea compatible' : 'líneas compatibles'}</option> })}
            </select>
            {!catalogue.templates.length && <span className="block text-muted-foreground">No hay plantillas aprobadas para tus líneas Cloud.</span>}
          </label>}
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium">Líneas para esta difusión · {form.lineIds.length} {form.lineIds.length===1 ? 'seleccionada' : 'seleccionadas'}</p>
              <Button size="sm" variant="outline" onClick={() => update({lineIds:catalogue.lines.filter(l => !lineCompatibility(l,form,catalogue.templates)).map(l => l.id)})}>Usar líneas compatibles</Button>
            </div>
            <p className="mb-2 text-xs text-muted-foreground">Podés quitar líneas. Al cambiar la plantilla se seleccionan las compatibles; el cupo se verifica al calcular.</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {catalogue.lines.map(line => {
                const reason = lineCompatibility(line,form,catalogue.templates)
                return <label key={line.id} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${reason ? 'bg-muted/50 text-muted-foreground' : ''}`}>
                  <input type="checkbox" className="mt-1" disabled={!!reason} checked={!reason && form.lineIds.includes(line.id)} onChange={e => update({lineIds:e.target.checked ? [...form.lineIds,line.id] : form.lineIds.filter(id => id !== line.id)})}/>
                  <span>{line.name}<span className="block text-xs text-muted-foreground">{line.type === 'cloud' ? 'Cloud' : 'Evolution'} · {reason ?? 'Compatible'}</span></span>
                </label>
              })}
              {!catalogue.lines.length && <p className="text-sm text-muted-foreground">No tenés líneas disponibles para preparar una difusión.</p>}
            </div>
            {!form.lineIds.length && !!catalogue.lines.length && <p className="mt-2 text-xs text-muted-foreground">Elegí una plantilla con líneas disponibles o revisá el estado de tus líneas. <a href="/lines" className="underline">Ir a Líneas</a></p>}
          </div>
        </fieldset>
        {!!form.startTime && !!form.endTime && form.startTime >= form.endTime && <p role="alert" className="text-sm text-destructive">La hora de cierre debe ser posterior a la hora de inicio.</p>}
        <p className="text-xs text-muted-foreground">Para hoy, el cálculo comienza desde la hora actual si ya pasó el inicio elegido. Los planes futuros son proyecciones y no programan envíos.</p>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">La reserva se calcula sobre el límite diario de cada línea. Se conserva el remitente habitual.</p>
          <Button onClick={calculate} disabled={calculating || !form.lineIds.length || !form.planDate || !form.startTime || form.startTime >= form.endTime || !form.endTime || form.maxContacts<1 || form.maxContacts>5000 || form.reservePercent<0 || form.reservePercent>50 || (form.messageType==='template' && !form.templateId)}>
            {calculating && <Loader2 size={16} className="mr-2 animate-spin"/>}{calculating ? 'Calculando…' : plan ? 'Actualizar plan' : 'Calcular plan'}
          </Button>
        </div>
      </>}
      {plan && <div className="space-y-4 border-t pt-4" aria-label="Resultado del plan">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[['Analizados',plan.total],['Seleccionados',plan.selected],['Pendientes',plan.pending],['Excluidos',plan.excluded]].map(([label,value]) => <div key={label} className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">{label}</p><p className="text-2xl font-semibold tabular-nums">{Number(value).toLocaleString('es-AR')}</p>
          </div>)}
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Difusión prevista: {new Date(plan.startsAt).toLocaleDateString('es-AR',{timeZone:'America/Argentina/Buenos_Aires'})} · {new Date(plan.startsAt).toLocaleTimeString('es-AR',{timeZone:'America/Argentina/Buenos_Aires',hour:'2-digit',minute:'2-digit',hour12:false})} a {new Date(plan.endsAt).toLocaleTimeString('es-AR',{timeZone:'America/Argentina/Buenos_Aires',hour:'2-digit',minute:'2-digit',hour12:false})}</p>
          <p>Plan calculado: {new Date(plan.generatedAt).toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires',hour12:false})}</p>
          {plan.computedAt && <p>Prioridades actualizadas: {new Date(plan.computedAt).toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires',hour12:false})}</p>}
        </div>
        <div className="rounded-lg border bg-primary/5 p-4 space-y-3">
          <p className="text-sm font-medium">{plan.selected ? `${plan.selected.toLocaleString('es-AR')} contactos listos para crear una campaña` : 'Todavía no hay contactos listos para esta difusión'}</p>
          <p className="text-xs text-muted-foreground">De {plan.total.toLocaleString('es-AR')} analizados, {plan.pending.toLocaleString('es-AR')} quedan pendientes y {plan.excluded.toLocaleString('es-AR')} excluidos. Los pendientes se pueden revisar para otra fecha; los excluidos requieren revisar sus datos o elegibilidad.</p>
          <div className="flex flex-wrap gap-2">{plan.lines.filter(l => l.selected).map(l => <span key={l.id} className="rounded-full border bg-background px-3 py-1 text-xs">{l.name}: {l.selected}</span>)}</div>
          <Button onClick={createFromPlan} disabled={!plan.selected || !plan.fingerprint || !user?.id || !canCreateCampaign}>Crear campaña con este plan</Button>
          {!canCreateCampaign && <p className="text-xs text-muted-foreground">Para crear la campaña necesitás acceso de lectura a Contactos y Campañas.</p>}
          <p className="text-xs text-muted-foreground">Después completás el mensaje, revisás y elegís guardar un borrador o programar. Antes de guardar se verifica nuevamente la disponibilidad.</p>
        </div>
        {plan.lines.some(l => l.reason) && <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm space-y-2">
          <p className="font-medium">Revisá estas líneas</p>
          {plan.lines.filter(l => l.reason).map(l => <p key={l.id}><span className="font-medium">{l.name}:</span> {l.reason}</p>)}
          <a href="/lines" className="inline-block text-xs underline">Ver estado y alertas de las líneas</a>
        </div>}
        {!!plan.reasons.length && <div className="space-y-2" aria-label="Qué hacer con los contactos restantes">
          {plan.reasons.map(r => <div key={r.code} className="rounded-lg bg-muted p-3 text-sm"><p className="font-medium">{r.count} · {r.label}</p><p className="mt-1 text-xs text-muted-foreground">{PLAN_REASON_ACTIONS[r.code]}</p></div>)}
          {catalogue && !!plan.pending && <div className="flex flex-wrap gap-2">{catalogue.days.filter(d => d.date !== form.planDate).map(d => <Button key={d.date} size="sm" variant="outline" onClick={() => update({planDate:d.date})}>Probar {d.label.toLowerCase()}</Button>)}</div>}
        </div>}
        <details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">Ver cómo se calculó el cupo</summary>
        <div className="mt-3 overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Capacidad y reparto por línea</caption>
            <thead className="bg-muted"><tr>{['Línea','Límite diario','Consumo al inicio','Cupo recomendado','Pendientes hasta cierre','Reserva','Cupo estimado','Seleccionados'].map(label => <th key={label} className="p-3 font-medium">{label}</th>)}</tr></thead>
            <tbody>{plan.lines.map(line => <tr key={line.id} className="border-t">
              <td className="p-3"><span className="font-medium">{line.name}</span><p className="text-muted-foreground">{line.hourlyLimit}/hora</p>{line.recommendation && <p className="mt-1 max-w-64 text-muted-foreground">{line.recommendation}</p>}{line.reason && line.reason !== line.recommendation && <p className="mt-1 text-amber-700 dark:text-amber-400">{line.reason}</p>}</td>
              {[line.dailyLimit,line.used,line.recommendedRemaining ?? '—',line.committed,line.reserve,line.capacity,line.selected].map((value,index) => <td key={index} className="p-3 tabular-nums">{value}</td>)}
            </tr>)}</tbody>
          </table>
        </div>
        {!!groups.size && <div className="flex flex-wrap gap-2">{[...groups].map(([segment,count]) => <span key={segment} className="rounded-full bg-success/10 px-3 py-1 text-xs">{labels[segment] ?? segment}: {count}</span>)}</div>}
        <div className="space-y-1 text-xs text-muted-foreground">{plan.warnings.map(w => <p key={w}>{w}</p>)}</div>
        </details>
        {!plan.total && <p className="py-3 text-center text-sm">No hay contactos pendientes para estos filtros.</p>}
        {!!plan.total && <>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={tab==='selected'?'default':'outline'} onClick={() => {setTab('selected');setPage(1)}}>Ver seleccionados ({plan.selected})</Button>
            <Button size="sm" variant={tab==='pending'?'default':'outline'} onClick={() => {setTab('pending');setPage(1)}}>Ver pendientes ({plan.pending})</Button>
            <Button size="sm" variant={tab==='excluded'?'default':'outline'} onClick={() => {setTab('excluded');setPage(1)}}>Ver excluidos ({plan.excluded})</Button>
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
