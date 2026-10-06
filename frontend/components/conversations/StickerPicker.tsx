'use client'
import { useEffect, useRef, useState } from 'react'
import { Sticker, Loader2, Star, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

type Prepared = {url:string;token:string;slot?:number;name?:string}
type Favorite = {slot:number;name:string;preview:string}
const favoritesUrl='/api/conversations/stickers/favorites'
async function responseJson(response:Response) {
  const result=await response.json()
  if(!response.ok)throw new Error(result.error || 'No se pudo completar la operación.')
  return result
}
export function StickerPicker({disabled,onSend}:{disabled:boolean;onSend:(url:string,token:string)=>Promise<boolean>}) {
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const [sticker,setSticker]=useState<Prepared|null>(null)
  const [favorites,setFavorites]=useState<Favorite[]>([]),[name,setName]=useState('')
  const [loadingFavorites,setLoadingFavorites]=useState(false)
  const operation=useRef(0)
  async function refreshFavorites(signal?:AbortSignal) {
    const data=await fetch(favoritesUrl,{signal,cache:'no-store'}).then(responseJson)
    setFavorites(data.favorites)
  }
  useEffect(()=>{
    if(!open)return
    const controller=new AbortController();setLoadingFavorites(true)
    void refreshFavorites(controller.signal).catch(()=>{if(!controller.signal.aborted)setError('No se pudieron cargar tus favoritos. Cerrá y volvé a abrir para reintentar.')}).finally(()=>{if(!controller.signal.aborted)setLoadingFavorites(false)})
    return ()=>controller.abort()
  },[open])
  async function upload(file:File|undefined) {
    if(!file)return
    const id=++operation.current;setBusy(true);setError('');setSticker(null);setName(file.name.replace(/\.[^.]+$/,'').slice(0,80))
    try {
      const form=new FormData();form.set('file',file)
      const result=await fetch('/api/conversations/stickers',{method:'POST',body:form,signal:AbortSignal.timeout(30_000)}).then(responseJson)
      if(id===operation.current)setSticker(result)
    }catch(e){if(id===operation.current)setError(e instanceof Error?e.message:'Error de carga')}
    finally{if(id===operation.current)setBusy(false)}
  }
  async function choose(slot:number) {
    setBusy(true);setError('');setSticker(null)
    try {const data=await fetch(`${favoritesUrl}?slot=${slot}`,{cache:'no-store',signal:AbortSignal.timeout(20_000)}).then(responseJson);setSticker(data);setName(data.name)}
    catch(e){setError(e instanceof Error?e.message:'Error al elegir favorito')}
    finally{setBusy(false)}
  }
  async function save() {
    if(!sticker)return
    setBusy(true);setError('')
    try {
      const data=await fetch(favoritesUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...sticker,name}),signal:AbortSignal.timeout(20_000)}).then(responseJson)
      setSticker({...sticker,slot:data.slot});await refreshFavorites()
    }catch(e){setError(e instanceof Error?e.message:'No se pudo guardar')}
    finally{setBusy(false)}
  }
  async function remove(slot:number) {
    setBusy(true);setError('')
    try {
      await fetch(`${favoritesUrl}?slot=${slot}`,{method:'DELETE',signal:AbortSignal.timeout(20_000)}).then(responseJson)
      setFavorites(prev=>prev.filter(item=>item.slot!==slot));if(sticker?.slot===slot)setSticker({...sticker,slot:undefined})
    }catch(e){setError(e instanceof Error?e.message:'No se pudo quitar')}
    finally{setBusy(false)}
  }
  return <>
    <Button type="button" variant="ghost" size="icon" aria-label="Enviar sticker" disabled={disabled} onClick={()=>setOpen(true)} className="h-9 w-9 shrink-0"><Sticker size={18}/></Button>
    <Dialog open={open} onOpenChange={v=>{if(!busy)setOpen(v)}}><DialogContent className="sm:max-w-sm"><DialogHeader><DialogTitle>Enviar sticker</DialogTitle></DialogHeader>
      <section aria-label="Stickers favoritos" className="space-y-2">
        <h3 className="text-sm font-medium flex items-center gap-2"><Star size={15}/>Mis favoritos <span className="text-xs text-muted-foreground">{favorites.length}/24</span></h3>
        {loadingFavorites?<p className="text-xs text-muted-foreground">Cargando favoritos…</p>:favorites.length===0?<p className="text-xs text-muted-foreground">Cargá un sticker y guardalo para reutilizarlo desde cualquier dispositivo.</p>:<div className="grid grid-cols-4 gap-2 max-h-44 overflow-y-auto">
          {favorites.map(item=><div key={item.slot} className="relative rounded border p-1">
            <button type="button" disabled={busy||disabled} className="w-full rounded focus-visible:ring-2 focus-visible:ring-primary" onClick={()=>void choose(item.slot)} aria-label={`Usar ${item.name}`} title={item.name}><img src={item.preview} alt={item.name} className="h-14 w-full object-contain"/><span className="block truncate text-[10px]">{item.name}</span></button>
            <button type="button" disabled={busy||disabled} aria-label={`Quitar ${item.name} de favoritos`} onClick={()=>void remove(item.slot)} className="absolute right-0 top-0 rounded bg-background p-1 shadow-sm"><Trash2 size={12}/></button>
          </div>)}
        </div>}
      </section>
      <p className="text-xs text-muted-foreground">PNG, JPG o WebP de hasta 5 MB. Los animados deben ser WebP de 512×512 y hasta 500 KB.</p>
      <input className="w-full min-w-0 text-xs" type="file" accept="image/png,image/jpeg,image/webp" aria-label="Imagen del sticker" disabled={busy||disabled} onChange={e=>void upload(e.target.files?.[0])}/>
      {sticker&&<><img src={sticker.url} alt="Vista previa del sticker" className="mx-auto h-32 w-32 object-contain"/>
        {sticker.slot?<p className="text-xs text-muted-foreground">★ Guardado en tus favoritos</p>:<div className="flex gap-2"><input aria-label="Nombre del favorito" className="min-w-0 flex-1 rounded border px-2 text-sm" maxLength={80} value={name} onChange={e=>setName(e.target.value)} placeholder="Nombre del favorito" disabled={busy}/><Button variant="outline" size="sm" onClick={()=>void save()} disabled={busy||disabled||!name.trim()}><Star size={14}/>Guardar</Button></div>}
      </>}
      {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button disabled={!sticker||busy||disabled} onClick={async()=>{if(!sticker||busy)return;setBusy(true);try{if(await onSend(sticker.url,sticker.token)){setOpen(false);setSticker(null)}else setError('No se pudo enviar. Revisá el aviso de la conversación.')}finally{setBusy(false)}}}>{busy?<Loader2 className="animate-spin" size={16}/>:null}Enviar sticker</Button>
    </DialogContent></Dialog>
  </>
}
