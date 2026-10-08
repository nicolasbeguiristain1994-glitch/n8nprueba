'use client'
import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useSearchParams } from 'next/navigation'
import { cloudMessageText, type CloudMessageContent } from '@/lib/cloud-api/message-content'
type Line = { id: string; display_name: string; cloud_phone_number_id: string | null }
type Message = { id: string; direction: string; status: string; message_type: string; content: CloudMessageContent; sent_at: string; error_title?: string }
export default function CloudInboxPage() {
  return <Suspense fallback={<div className="surface p-6 text-sm text-muted-foreground">Cargando bandeja…</div>}><CloudInbox /></Suspense>
}
function CloudInbox() {
  const requestedPhone=useSearchParams().get('phoneNumberId')?.trim() || ''
  const [lines,setLines]=useState<Line[]>([]),[phone,setPhone]=useState(''),[contact,setContact]=useState(''),[text,setText]=useState(''),[template,setTemplate]=useState(''),[language,setLanguage]=useState('es_AR')
  const [conversations,setConversations]=useState<{id:string;contact_phone:string;last_message_preview:string}[]>([]),[messages,setMessages]=useState<Message[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0),[requestedDenied,setRequestedDenied]=useState(false)
  // Selección inicial: sólo la línea pedida si está entre las accesibles; si no se pidió ninguna y hay una sola, esa.
  useEffect(()=>{
    const controller=new AbortController()
    setLines([]);setPhone('');setContact('');setText('');setTemplate('');setLanguage('es_AR')
    setConversations([]);setMessages([]);setError('');setRequestedDenied(false)
    fetch('/api/lines',{signal:controller.signal}).then(async r=>{
      const d=await r.json().catch(()=>null)
      if(controller.signal.aborted)return
      if(!r.ok||!d)throw Error(d?.error || `No se pudieron cargar las líneas (HTTP ${r.status})`)
      const cloud:Line[]=(d.lines ?? []).filter((l:Line)=>l.cloud_phone_number_id)
      setLines(cloud)
      if(requestedPhone){ if(cloud.some(l=>l.cloud_phone_number_id===requestedPhone))setPhone(requestedPhone);else setRequestedDenied(true) }
      else if(cloud.length===1)setPhone(cloud[0].cloud_phone_number_id!)
    }).catch(e=>{if(!controller.signal.aborted&&e.name!=='AbortError')setError(e.message)})
    return()=>controller.abort()
  },[requestedPhone])
  useEffect(()=>{
    if(!phone){setConversations([]);setMessages([]);return}
    const controller=new AbortController();setError('');setMessages([])
    fetch(`/api/cloud/inbox?phoneNumberId=${encodeURIComponent(phone)}${contact?`&contact=${encodeURIComponent(contact)}`:''}`,{signal:controller.signal}).then(async r=>{const d=await r.json();if(controller.signal.aborted)return;if(!r.ok)throw Error(d.error);if(contact)setMessages(d.messages.slice().reverse());else setConversations(d.conversations)}).catch(e=>{if(!controller.signal.aborted&&e.name!=='AbortError')setError(e.message)})
    return()=>controller.abort()
  },[phone,contact,revision])
  async function send(){
    setBusy(true);setError('')
    try{
      const r=await fetch('/api/cloud/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phoneNumberId:phone,to:contact,type:template?'template':'text',...(template?{template:{name:template,language:{code:language},components:[]}}:{text:{body:text}})})})
      const d=await r.json();if(!r.ok)throw Error(d.error || 'Error de envío');setText('');setRevision(v=>v+1)
    }catch(e){setError(e instanceof Error?e.message:'Error de conexión')}finally{setBusy(false)}
  }
  return <div className="max-w-5xl space-y-5">
    <Link href="/lines" className="text-sm font-medium text-primary">← Líneas</Link>
    <PageHeader title="Bandeja de WhatsApp API" className="mb-0"
      description="Consultá mensajes y estados de tus números oficiales. Texto libre dentro de las 24 horas del último mensaje del cliente; fuera de esa ventana, usá una plantilla aprobada." />
    <div className="filter-bar">
      <label className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm font-medium">
        Línea
        <select className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-card px-3 text-sm shadow-xs focus-visible:ring-2 focus-visible:ring-ring" value={phone} onChange={e=>{setPhone(e.target.value);setContact('');setRequestedDenied(false)}}>
          <option value="">Seleccionar</option>
          {lines.map(l=><option key={l.id} value={l.cloud_phone_number_id!}>{l.display_name}</option>)}
        </select>
      </label>
      <Button variant="outline" onClick={()=>setRevision(v=>v+1)}>Actualizar mensajes y estados</Button>
    </div>
    {requestedDenied&&<p role="alert" className="rounded-xl border border-warning/20 bg-warning/10 p-4 text-sm text-warning">La línea solicitada no existe o no tenés acceso a ella. Elegí una línea de la lista.</p>}
    {error&&<p role="alert" className="rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">{error}</p>}
    {!contact&&conversations.map(c=><button key={c.id} className="surface block w-full p-4 text-left transition-colors hover:bg-primary/5" onClick={()=>setContact(c.contact_phone)}>
      <span className="block text-sm font-semibold">{c.contact_phone}</span>
      <span className="mt-1 block truncate text-sm text-muted-foreground">{c.last_message_preview}</span>
    </button>)}
    <label className="block max-w-md text-sm font-medium">Destinatario autorizado
      <Input className="mt-2" placeholder="+549…" value={contact} onChange={e=>setContact(e.target.value)} />
    </label>
    {contact&&<>
      <Button variant="ghost" onClick={()=>setContact('')}>← Volver a conversaciones</Button>
      <div className="space-y-3">{messages.map(m=><article key={m.id} className="surface p-4">
        <p className="text-xs text-muted-foreground">{m.direction==='inbound'?'Recibido':'Enviado'} · {m.status} · {new Date(m.sent_at).toLocaleString('es-AR')}</p>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{cloudMessageText(m.content,m.message_type)}</p>
        {m.error_title&&<p className="mt-2 text-sm text-destructive">{m.error_title}</p>}
      </article>)}</div>
      <div className="surface space-y-4 p-5">
        <label className="block text-sm font-medium">Mensaje
          <Textarea className="mt-2 min-h-28" value={text} onChange={e=>setText(e.target.value)} maxLength={4096} />
        </label>
        <details className="rounded-xl border border-border bg-muted/20 p-4">
          <summary className="cursor-pointer text-sm font-medium">Usar plantilla aprobada sin variables</summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium">Nombre exacto<Input className="mt-2" value={template} onChange={e=>setTemplate(e.target.value)} /></label>
            <label className="block text-sm font-medium">Idioma<Input className="mt-2" value={language} onChange={e=>setLanguage(e.target.value)} /></label>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">Si completás el nombre, se envía la plantilla en lugar del texto. Las plantillas con variables se gestionan desde Campañas.</p>
        </details>
        <Button disabled={busy||!phone||(!text.trim()&&!template)} onClick={send}>{busy?'Enviando…':'Enviar mensaje'}</Button>
      </div>
    </>}
    {!lines.length&&<Link href="/lines/cloud-onboard" className="block text-sm font-medium text-primary">Conectar un número oficial →</Link>}
  </div>
}
