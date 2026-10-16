'use client'

import { useEffect, useState } from 'react'
import { GitBranch, Loader2, RefreshCw } from 'lucide-react'
import type { CampaignRoutingPreview as Preview } from '@/lib/campaign-routing-preview'

export function CampaignRoutingPreview({ audience, messageType, templateId, scheduled }: {
  audience: {contact_ids?:string[];list_id?:string;prospect_list_id?:string}
  messageType:'text'|'template'; templateId?:string; scheduled:boolean
}) {
  const request = JSON.stringify({...audience,message_type:messageType,...(messageType==='template' ? {template_id:templateId} : {})})
  const [result,setResult] = useState<{request:string;data:Preview}|null>(null)
  const [error,setError] = useState<string|null>(null)
  const [loading,setLoading] = useState(true)
  const [refresh,setRefresh] = useState(0)
  useEffect(()=>{
    const controller=new AbortController()
    let current=true
    setLoading(true); setError(null); setResult(null)
    const timeout=setTimeout(()=>controller.abort(),20000)
    void (async()=>{
      try {
        const res=await fetch('/api/campaigns/routing-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:request,signal:controller.signal})
        const data=await res.json()
        if(!res.ok) throw new Error(data.error||'No se pudo calcular el reparto.')
        if(current) setResult({request,data})
      } catch(e) { if(current) setError(e instanceof Error && e.name!=='AbortError' ? e.message : 'La consulta tardó demasiado. Volvé a intentar.') }
      finally { clearTimeout(timeout); if(current) setLoading(false) }
    })()
    return ()=>{current=false;clearTimeout(timeout);controller.abort()}
  },[request,refresh])
  const data=result?.request===request ? result.data : null
  const n=(value:number)=>value.toLocaleString('es-AR')
  return <div className="rounded-xl border border-primary/20 bg-accent/20 p-4 space-y-3" aria-label="Reparto por líneas">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 font-semibold"><GitBranch size={16}/>Reparto estimado por línea</h3>
      <button type="button" disabled={loading} onClick={()=>setRefresh(value=>value+1)} className="inline-flex items-center gap-1 text-xs text-primary disabled:opacity-50"><RefreshCw size={13}/>Actualizar reparto</button>
    </div>
    <p className="text-xs text-muted-foreground">Los contactos habituales conservan su línea. Los nuevos se reparten por turnos entre las líneas disponibles{messageType==='template' ? ' de la cuenta de esta plantilla' : ''}.</p>
    {loading ? <p role="status" className="flex items-center gap-2 text-sm"><Loader2 size={15} className="animate-spin"/>Calculando reparto…</p>
      : error ? <p role="alert" className="text-sm text-destructive">{error}</p>
      : data && <>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div><dt className="text-muted-foreground">Destinatarios</dt><dd className="text-xl font-semibold">{n(data.eligible)}</dd></div>
          <div><dt className="text-muted-foreground">Con cupo ahora</dt><dd className="text-xl font-semibold">{n(data.eligible-data.pending)}</dd></div>
          <div><dt className="text-muted-foreground">Pendientes por línea o cupo</dt><dd className={`text-xl font-semibold ${data.pending?'text-orange-600':''}`}>{n(data.pending)}</dd></div>
        </dl>
        {data.excluded>0&&<p className="text-xs text-muted-foreground">{n(data.excluded)} excluidos por bajas, bloqueos, estado o teléfono repetido.</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          {data.lines.map(line=><div key={line.id} className="rounded-lg border bg-card p-3 text-sm">
            <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium break-words">{line.name}</p>{line.phone&&<p className="text-xs text-muted-foreground">{line.phone}</p>}</div><p className="shrink-0 font-semibold">{n(line.assigned)} <span className="font-normal text-xs">{line.assigned===1?'contacto':'contactos'}</span></p></div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true"><div className="h-full rounded-full bg-primary" style={{width:`${data.eligible ? line.assigned/data.eligible*100 : 0}%`}}/></div>
            <p className="mt-2 text-xs text-muted-foreground">Habituales: {n(line.habitual)} · Nuevos: {n(line.new)}</p>
            <p className="mt-1 text-xs text-muted-foreground">Cupo restante: {n(line.remaining_hour)} esta hora · {n(line.remaining_day)} hoy</p>
            {line.reason&&<p className="mt-1 text-xs text-orange-600">{line.reason}</p>}
            {line.pending>0&&<p className="mt-1 text-xs text-orange-600">{n(line.pending)} pendientes; conservan esta línea.</p>}
          </div>)}
        </div>
        {data.unassigned>0&&<p className="text-sm text-orange-600">{n(data.unassigned)} contactos nuevos sin línea disponible para asignar.</p>}
        {data.hidden_line_contacts>0&&<p className="text-sm text-orange-600">{n(data.hidden_line_contacts)} contactos conservan una línea a la que ya no tenés acceso y quedarían pendientes.</p>}
        {!data.lines.length&&!data.eligible&&<p className="text-sm text-muted-foreground">No hay destinatarios habilitados para repartir.</p>}
        <p className="text-xs text-muted-foreground">Calculado a las {new Date(data.calculated_at).toLocaleTimeString('es-AR',{timeZone:'America/Argentina/Buenos_Aires',hour:'2-digit',minute:'2-digit'})} (Argentina). {scheduled?'La programación usa las líneas y los cupos disponibles al momento del envío. ':''}Es una estimación: otras campañas pueden consumir cupo. Al enviar se revisan nuevamente bajas, frecuencia{messageType==='text'?', ventana de 24 horas en Cloud':''} y disponibilidad.{data.has_variable_schedule?' Las pausas de las líneas también pueden modificar el reparto.':''}</p>
      </>}
  </div>
}
