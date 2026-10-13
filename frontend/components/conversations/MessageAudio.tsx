'use client'

import { useState } from 'react'
import { Headphones, Loader2 } from 'lucide-react'

export function MessageAudio({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const url = src && attempt ? `${src}${src.includes('?') ? '&' : '?'}retry=${attempt}` : src

  return <div className="space-y-2 py-1">
    <p className="flex items-center gap-2 text-xs font-medium"><Headphones size={16} aria-hidden="true" />Audio</p>
    {!src || failed ? <div role="status" className="space-y-2 text-xs">
      <p>{src ? 'No se pudo reproducir el audio. El archivo puede haber vencido o el formato no ser compatible con tu navegador.' : 'No se encontró un archivo para este audio.'}</p>
      {src && <button type="button" className="underline underline-offset-2" onClick={() => {
        setFailed(false); setLoading(false); setAttempt(value => value + 1)
      }}>Reintentar audio</button>}
    </div> : <>
      <audio key={attempt} controls preload="none" src={url} aria-label="Reproducir audio del mensaje"
        className="block w-full min-w-0 h-11"
        onPlay={() => setLoading(true)} onWaiting={() => setLoading(true)} onPause={() => setLoading(false)}
        onCanPlay={() => setLoading(false)} onPlaying={() => setLoading(false)}
        onError={() => { setLoading(false); setFailed(true) }} />
      {loading && <p role="status" className="flex items-center gap-2 text-xs"><Loader2 size={14} className="animate-spin" />Cargando audio…</p>}
    </>}
  </div>
}
