'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { fetchJson } from '@/lib/fetchJson'
import { Button } from '@/components/ui/button'
import { MessageBubble } from '@/components/conversations/MessageBubble'
import type { Message } from '@/lib/scoring/conversation-scoring'
export function ContactMessages({phone}: {phone:string}) {
  const [messages,setMessages]=useState<Message[]>([])
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState(false)
  const [retry,setRetry]=useState(0)
  useEffect(()=>{let active=true;setLoading(true);setError(false);setMessages([]);fetchJson<{messages:Message[]}>(`/api/conversations?phone=${encodeURIComponent(phone)}`).then(d=>{if(active)setMessages(d.messages||[])}).catch(()=>{if(active)setError(true)}).finally(()=>{if(active)setLoading(false)});return()=>{active=false}},[phone,retry])
  return <section className="space-y-4" aria-label="Conversación del contacto">
    <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">Mensajes registrados</h3><Link href={`/conversations?phone=${encodeURIComponent(phone)}`} className="text-sm font-medium text-primary hover:underline">Abrir conversación →</Link></div>
    {loading?<p role="status" className="py-8 text-center text-muted-foreground">Cargando mensajes…</p>:error?<div role="alert" className="rounded-lg border p-4">No se pudieron cargar los mensajes.<Button variant="ghost" onClick={()=>setRetry(n=>n+1)}>Reintentar</Button></div>:messages.length===0?<p className="py-8 text-center text-muted-foreground">Sin mensajes registrados para este contacto.</p>:<div className="space-y-3">{messages.map(m=><MessageBubble key={m.id} m={m}/>)}</div>}
  </section>
}
