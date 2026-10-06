'use client'
import { EMPTY_BROADCAST, broadcastError, type BroadcastRange } from '@/lib/broadcast-range'
import { useEffect, useState } from 'react'
import { Bookmark, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EMPTY_INACTIVITY, type InactivityRange } from '@/lib/inactivity-range'

export interface ContactViewState {
  broadcast?: BroadcastRange
  quality?: string; recent?: string
  search: string; segments: string[]; gaming: string; panel: string; linea: string; lineaSub: string
  inactivity: InactivityRange; actividad: string[]; antiguedad: string[]; plataforma: string
  sinMovimiento: boolean; tag: string; list: string; columns: Record<string, boolean>
}
export const CONTACT_COLUMNS = { gaming: false, casino: false, created_at: false, opt_in: false }
export const DEFAULT_CONTACT_VIEW: ContactViewState = { broadcast:EMPTY_BROADCAST, quality:'', recent:'', search:'', segments:[], gaming:'', panel:'', linea:'', lineaSub:'', inactivity:EMPTY_INACTIVITY, actividad:[], antiguedad:[], plataforma:'', sinMovimiento:false, tag:'', list:'', columns:CONTACT_COLUMNS }
export function isContactView(value: unknown): value is ContactViewState {
  if (!value || typeof value !== 'object') return false
  const v = value as ContactViewState
  return (v.broadcast===undefined || (v.broadcast!==null && typeof v.broadcast==='object' && ['mode','period','days','from','to'].every(k=>typeof v.broadcast![k as keyof BroadcastRange]==='string') && !broadcastError(v.broadcast))) && (v.quality===undefined||typeof v.quality==='string') && (v.recent===undefined||typeof v.recent==='string') && ['search','gaming','panel','linea','lineaSub','plataforma','tag','list'].every(k=>typeof v[k as keyof ContactViewState]==='string') &&
    [v.segments,v.actividad,v.antiguedad].every(a=>Array.isArray(a)&&a.every(x=>typeof x==='string')) &&
    typeof v.sinMovimiento==='boolean' && !!v.inactivity && typeof v.inactivity.min==='string' && typeof v.inactivity.max==='string' && (v.inactivity.mode===undefined || v.inactivity.mode==='period') &&
    !!v.columns && typeof v.columns==='object' && !Array.isArray(v.columns) && Object.values(v.columns).every(x=>typeof x==='boolean')
}
interface SavedView { id: string; name: string; state: ContactViewState }
export function SavedContactViews({userId,state,onApply}: {userId?:string; state:ContactViewState; onApply:(state:ContactViewState)=>void}) {
  const [views,setViews]=useState<SavedView[]>([])
  const [open,setOpen]=useState(false)
  const [name,setName]=useState('')
  const [error,setError]=useState('')
  const key=userId ? `crm:contact-views:${userId}` : null
  useEffect(()=>{setViews([]);setError('');if(!key)return;try{const data=JSON.parse(localStorage.getItem(key)||'[]');if(Array.isArray(data))setViews(data.filter(v=>typeof v?.id==='string'&&typeof v?.name==='string'&&isContactView(v.state)).slice(0,20))}catch{setError('No se pudieron leer las vistas guardadas.')}},[key])
  const persist=(next:SavedView[])=>{if(!key)return false;try{localStorage.setItem(key,JSON.stringify(next));setViews(next);setError('');return true}catch{setError('No se pudo guardar la vista en este navegador.');return false}}
  const active=views.find(v=>JSON.stringify(v.state)===JSON.stringify(state))
  const save=()=>{const label=name.trim();if(!label)return;if(views.some(v=>v.name.toLowerCase()===label.toLowerCase())){setError('Ya existe una vista con ese nombre.');return}if(persist([...views,{id:crypto.randomUUID(),name:label,state}])){setOpen(false);setName('')}}
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2" aria-label="Vistas de contactos">
      <Bookmark size={15} className="text-muted-foreground" aria-hidden="true"/>
      <select aria-label="Vista de contactos" className="h-8 min-w-0 max-w-full rounded-md border bg-card px-2 text-sm" value={active?.id||''} onChange={e=>{const view=views.find(v=>v.id===e.target.value);if(view)onApply(view.state);else onApply(DEFAULT_CONTACT_VIEW)}}>
        <option value="">{JSON.stringify(state)===JSON.stringify(DEFAULT_CONTACT_VIEW)?'Todos los contactos':'Vista actual · personalizada'}</option>
        {views.map(v=><option value={v.id} key={v.id}>{v.name}</option>)}
      </select>
      <Button variant="ghost" size="sm" onClick={()=>onApply(DEFAULT_CONTACT_VIEW)}>Restablecer</Button>
      <Button variant="ghost" size="sm" disabled={!key||views.length>=20} onClick={()=>{setError('');setOpen(true)}}><Plus size={14}/>Guardar vista</Button>
      {active&&<Button variant="ghost" size="icon-sm" aria-label={`Eliminar vista ${active.name}`} onClick={()=>persist(views.filter(v=>v.id!==active.id))}><Trash2 size={14}/></Button>}
      <span className="text-xs text-muted-foreground sm:ml-auto">Vistas personales · este navegador</span>
    </div>
    {error&&!open&&<p role="alert" className="text-xs text-destructive">{error}</p>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-w-sm"><DialogHeader><DialogTitle>Guardar vista</DialogTitle></DialogHeader>
      <form onSubmit={e=>{e.preventDefault();save()}} className="space-y-4">
        <p className="text-sm text-muted-foreground">Guardá los filtros y columnas actuales para volver a esta selección. No modifica tus listas.</p>
        <label className="block space-y-1 text-sm">Nombre de la vista<Input autoFocus maxLength={60} value={name} onChange={e=>setName(e.target.value)} placeholder="Ej.: VIP de mi agente"/></label>
        {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={()=>setOpen(false)}>Cancelar</Button><Button type="submit" disabled={!name.trim()}>Guardar vista</Button></div>
      </form>
    </DialogContent></Dialog>
  </div>
}
