'use client'
import { useRef, useState } from 'react'
import { Sticker, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function StickerPicker({disabled,onSend}:{disabled:boolean;onSend:(url:string,token:string)=>Promise<boolean>}) {
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const [sticker,setSticker]=useState<{url:string;token:string}|null>(null)
  const operation=useRef(0)
  async function upload(file:File|undefined) {
    if(!file)return
    const id=++operation.current;setBusy(true);setError('');setSticker(null)
    try {
      const form=new FormData();form.set('file',file)
      const response=await fetch('/api/conversations/stickers',{method:'POST',body:form,signal:AbortSignal.timeout(30_000)})
      const result=await response.json()
      if(!response.ok)throw new Error(result.error || 'No se pudo cargar el sticker')
      if(id===operation.current)setSticker(result)
    }catch(e){if(id===operation.current)setError(e instanceof Error?e.message:'Error de carga')}
    finally{if(id===operation.current)setBusy(false)}
  }
  return <>
    <Button type="button" variant="ghost" size="icon" aria-label="Enviar sticker" disabled={disabled} onClick={()=>setOpen(true)} className="h-9 w-9 shrink-0"><Sticker size={18}/></Button>
    <Dialog open={open} onOpenChange={v=>{if(!busy)setOpen(v)}}><DialogContent className="max-w-sm"><DialogHeader><DialogTitle>Enviar sticker</DialogTitle></DialogHeader>
      <p className="text-sm text-muted-foreground">Cargá un PNG, JPG o WebP de hasta 5 MB. Lo adaptamos a 512×512. Los animados deben ser WebP de 512×512 y hasta 500 KB.</p>
      <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Imagen del sticker" disabled={busy||disabled} onChange={e=>void upload(e.target.files?.[0])}/>
      {sticker&&<img src={sticker.url} alt="Vista previa del sticker" className="mx-auto h-40 w-40 object-contain"/>}
      {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button disabled={!sticker||busy||disabled} onClick={async()=>{if(!sticker||busy)return;setBusy(true);try{if(await onSend(sticker.url,sticker.token)){setOpen(false);setSticker(null)}else setError('No se pudo enviar. Revisá el aviso de la conversación.')}finally{setBusy(false)}}}>{busy?<Loader2 className="animate-spin" size={16}/>:null}Enviar sticker</Button>
    </DialogContent></Dialog>
  </>
}
