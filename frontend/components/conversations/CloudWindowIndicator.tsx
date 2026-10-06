'use client'
import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'

type WindowInfo = {lineName:string;expiresAt:string|null}
export function windowLabel(expiresAt: string|null, now:number) {
  const ms=expiresAt ? Date.parse(expiresAt)-now : 0
  if (!Number.isFinite(ms) || ms<=0) return {text:'Ventana cerrada · requiere plantilla aprobada',urgent:false,closed:true}
  const minutes=Math.ceil(ms/60_000)
  return {text:`Atención Cloud · quedan ${Math.floor(minutes/60)} h ${minutes%60} min`,urgent:ms<=3600_000,closed:false}
}

export function CloudWindowIndicator({phone}:{phone:string}) {
  const [info,setInfo]=useState<WindowInfo|null>(null)
  const [error,setError]=useState(false)
  const [clock,setClock]=useState({now:Date.now(),offset:0})
  useEffect(()=>{
    let alive=true,inFlight=false,controller:AbortController|undefined
    async function refresh() {
      if(document.hidden || inFlight)return
      inFlight=true;controller=new AbortController()
      const timeout=setTimeout(()=>controller?.abort(),15_000)
      try {
        const response=await fetch(`/api/conversations/window?phone=${encodeURIComponent(phone)}`,{signal:controller.signal,cache:'no-store'})
        if(!response.ok)throw new Error('window')
        const data=await response.json()
        if(alive){setInfo(data.window);setError(false);setClock({now:Date.now(),offset:Date.parse(data.serverNow)-Date.now()})}
      } catch {if(alive)setError(true)}
      finally{clearTimeout(timeout);inFlight=false}
    }
    setInfo(null);setError(false);void refresh()
    const timer=setInterval(()=>{setClock(c=>({...c,now:Date.now()}));void refresh()},30_000)
    const visible=()=>void refresh()
    document.addEventListener('visibilitychange',visible)
    window.addEventListener('focus',visible)
    return ()=>{alive=false;controller?.abort();clearInterval(timer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('focus',visible)}
  },[phone])
  if(error)return <p className="border-b px-3 py-2 text-xs text-muted-foreground">No se pudo actualizar la ventana Cloud. Reintentando…</p>
  if(!info)return null
  const label=windowLabel(info.expiresAt,clock.now+clock.offset)
  return <div role="status" className={`flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2 text-xs ${label.urgent?'bg-amber-50 text-amber-900':'bg-muted/40 text-muted-foreground'}`}>
    <Clock size={13} aria-hidden="true"/><span>{label.text}</span><span>· {info.lineName}</span>
    {info.expiresAt && <span title={new Date(info.expiresAt).toLocaleString('es-AR')}>· {label.closed?'Venció':'Vence'} {new Date(info.expiresAt).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}</span>}
  </div>
}
