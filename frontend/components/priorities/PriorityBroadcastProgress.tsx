'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { broadcastRequest } from './PriorityBroadcastComposer'
interface Batch {id:string;name:string;status:string;pause_reason:string|null;created_at:string;total_targets:number;template_name:string;sent:number;failed:number;skipped:number;pending:number}
const labels:Record<string,string>={draft:'Preparada',running:'Enviando',paused:'En pausa',completed:'Finalizada',cancelled:'Cancelada',scheduled:'Programada'}
const reasons:Record<string,string>={manual:'Pausa manual',no_eligible_lines:'Esperando una línea disponible',all_lines_outside_schedule:'Fuera del horario de envío',assigned_line_unavailable:'La línea asignada no está disponible',frequency_exhausted:'Se alcanzó el límite de frecuencia',systemic_error:'El envío se detuvo por un error',config_missing:'Revisá la configuración de envío'}
export function PriorityBroadcastProgress({version,onChanged,canSend,canManage}:{version:number;onChanged:()=>void;canSend:boolean;canManage:boolean}) {
  const [batches,setBatches]=useState<Batch[]>([])
  const [error,setError]=useState<string|null>(null)
  const [busy,setBusy]=useState<string|null>(null)
  const actionLock=useRef(false)
  const signature=useRef('')
  const callback=useRef(onChanged);callback.current=onChanged
  const refresh=useCallback(async()=>{
    try {
      const {broadcasts}=await broadcastRequest<{broadcasts:Batch[]}>('/api/contacts/prioritized/broadcasts',undefined,'GET')
      const next=JSON.stringify(broadcasts)
      if(signature.current&&signature.current!==next)callback.current()
      signature.current=next;setBatches(broadcasts)
    } catch(e){setError(e instanceof Error?e.message:'No se pudo consultar el progreso')}
  },[])
  useEffect(()=>{void refresh();const timer=setInterval(()=>{if(!document.hidden)void refresh()},10000);return()=>clearInterval(timer)},[refresh,version])
  async function action(id:string,kind:'resume'|'pause'|'retry'|'cancel') {
    if(actionLock.current)return
    actionLock.current=true;setBusy(id);setError(null)
    try {
      if(kind==='pause'||kind==='cancel')await broadcastRequest(`/api/campaigns/${id}`,{status:kind==='pause'?'paused':'cancelled'},'PATCH')
      else {
        if(kind==='retry')await broadcastRequest(`/api/campaigns/${id}/retry-failed`)
        await broadcastRequest(`/api/campaigns/${id}/dispatch`)
      }
    } catch(e){setError(e instanceof Error?e.message:'No se pudo completar la operación')}
    finally {actionLock.current=false;setBusy(null);await refresh();callback.current()}
  }
  if(!batches.length&&!error)return null
  return <details open className="surface p-4 space-y-3">
    <summary className="cursor-pointer text-sm font-semibold">Mis difusiones recientes</summary>
    {error&&<p role="alert" className="text-sm text-destructive">{error} <button className="underline" onClick={()=>{setError(null);void refresh()}}>Actualizar</button></p>}
    <div className="max-h-72 overflow-y-auto space-y-3">{batches.map(b=><div key={b.id} className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
      <div className="min-w-0 text-sm space-y-1">
        <p className="font-medium">{b.template_name} <span className="text-muted-foreground font-normal">· {labels[b.status]||b.status} · {new Date(b.created_at).toLocaleString('es-AR')}</span></p>
        <p role="status" className="text-muted-foreground">{b.sent} enviados de {b.total_targets} · {b.pending||(b.status==='draft'?b.total_targets:0)} pendientes · {b.failed} fallidos · {b.skipped} omitidos</p>
        {b.pause_reason&&<p className="text-xs text-warning">{reasons[b.pause_reason]||'Revisá el detalle en Campañas'}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {canSend&&['draft','paused'].includes(b.status)&&<Button size="sm" variant="outline" disabled={!!busy} onClick={()=>action(b.id,'resume')}>{busy===b.id?'Procesando…':'Continuar envío'}</Button>}
        {canSend&&['completed','paused'].includes(b.status)&&b.failed+b.skipped>0&&<Button size="sm" variant="outline" disabled={!!busy} onClick={()=>action(b.id,'retry')}>Reintentar fallidos</Button>}
        {canManage&&b.status==='running'&&<Button size="sm" variant="outline" disabled={!!busy} onClick={()=>action(b.id,'pause')}>Pausar</Button>}
        {canManage&&['draft','paused'].includes(b.status)&&<Button size="sm" variant="outline" disabled={!!busy} onClick={()=>action(b.id,'cancel')}>Cancelar difusión</Button>}
        <a className="text-sm text-primary underline self-center" href={`/campaigns?campaign=${b.id}`}>Ver detalle</a>
      </div>
    </div>)}</div>
    <p className="text-xs text-muted-foreground">Sólo se reintentan fallos confirmados. Los resultados inciertos requieren revisión en Campañas.</p>
  </details>
}
