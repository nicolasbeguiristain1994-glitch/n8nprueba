'use client'

import { useState } from 'react'
import { ImageOff, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'

export function MessageMedia({ src, sticker }: { src: string; sticker: boolean }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const label = sticker ? 'Sticker' : 'Imagen'
  const url = attempt && src.startsWith('/api/conversations/media?') ? `${src}&retry=${attempt}` : src
  return <>
    {state === 'error' ? <div role="status" className="max-w-64 space-y-2 py-2">
      <p className="flex items-center gap-2"><ImageOff size={18} />{label} no disponible</p>
      <p className="text-xs opacity-80">No se pudo cargar. Puede que el archivo ya no esté disponible en WhatsApp.</p>
      <button type="button" className="underline underline-offset-2" onClick={() => {
        setState('loading'); setAttempt(value => value + 1)
      }}>Reintentar</button>
    </div> : <button type="button" aria-label={`Ampliar ${label.toLowerCase()}`} disabled={state !== 'ready'}
      onClick={() => setExpanded(true)} className="relative block w-52 max-w-full rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2">
      {state === 'loading' && <span role="status" className="absolute inset-0 flex items-center justify-center gap-2 text-xs">
        <Loader2 size={16} className="animate-spin" />Cargando {label.toLowerCase()}…
      </span>}
      <img key={attempt} src={url} alt={label} loading="lazy" decoding="async"
        onLoad={() => setState('ready')} onError={() => setState('error')}
        className={`rounded-lg w-full h-52 object-contain ${state === 'loading' ? 'opacity-0' : ''}`} />
      {state === 'ready' && <span className="block pt-1 text-[10px] opacity-75">Tocá para ampliar</span>}
    </button>}
    <Dialog open={expanded} onOpenChange={setExpanded}>
      <DialogContent className="sm:max-w-3xl">
        <DialogTitle>{label}</DialogTitle>
        <DialogDescription className="sr-only">Vista ampliada del archivo del chat.</DialogDescription>
        <img src={url} alt={`${label} ampliada`} className="max-h-[75dvh] max-w-full object-contain mx-auto" />
      </DialogContent>
    </Dialog>
  </>
}
