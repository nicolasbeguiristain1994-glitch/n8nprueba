'use client'
import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { cloudMessageText, type CloudMessageContent } from '@/lib/cloud-api/message-content'
type Line = { id: string; display_name: string; cloud_phone_number_id: string | null }
type Message = { id: string; direction: string; status: string; message_type: string; content: CloudMessageContent; sent_at: string; error_title?: string }
export default function CloudInboxPage() {
  return <Suspense fallback={<main className="mx-auto max-w-4xl p-6">Cargando bandeja…</main>}><CloudInbox /></Suspense>
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
  return <main className="mx-auto max-w-4xl p-6 space-y-4">
    <Link href="/lines" className="text-primary">← Líneas</Link><h1 className="text-2xl font-semibold">Bandeja de WhatsApp API</h1>
    <p className="text-sm text-muted-foreground">Consultá mensajes y estados de tus números oficiales. Texto libre dentro de las 24 horas del último mensaje del cliente; fuera de esa ventana, usá una plantilla aprobada.</p>
    <label className="block">Línea<select className="ml-2 rounded border p-2" value={phone} onChange={e=>{setPhone(e.target.value);setContact('');setRequestedDenied(false)}}><option value="">Seleccionar</option>{lines.map(l=><option key={l.id} value={l.cloud_phone_number_id!}>{l.display_name}</option>)}</select></label>
    <button className="rounded border p-2" onClick={()=>setRevision(v=>v+1)}>Actualizar mensajes y estados</button>
    {requestedDenied&&<p role="alert" className="text-amber-800">La línea solicitada no existe o no tenés acceso a ella. Elegí una línea de la lista.</p>}
    {error&&<p role="alert" className="text-red-700">{error}</p>}
    {!contact&&conversations.map(c=><button key={c.id} className="block w-full rounded border p-3 text-left" onClick={()=>setContact(c.contact_phone)}>{c.contact_phone} · {c.last_message_preview}</button>)}
    <label className="block">Destinatario autorizado<input className="ml-2 rounded border p-2" placeholder="+549…" value={contact} onChange={e=>setContact(e.target.value)} /></label>
    {contact&&<><button className="text-primary" onClick={()=>setContact('')}>Volver a conversaciones</button><div className="space-y-2">{messages.map(m=><article key={m.id} className="rounded border p-3"><p>{m.direction==='inbound'?'Recibido':'Enviado'} · {m.status} · {new Date(m.sent_at).toLocaleString('es-AR')}</p><p className="whitespace-pre-wrap">{cloudMessageText(m.content,m.message_type)}</p>{m.error_title&&<p className="text-red-700">{m.error_title}</p>}</article>)}</div>
      <label className="block">Mensaje<textarea className="block w-full rounded border p-2" value={text} onChange={e=>setText(e.target.value)} maxLength={4096} /></label>
      <details className="rounded border p-3"><summary>Usar plantilla aprobada sin variables</summary><label className="block">Nombre exacto<input className="m-2 rounded border p-2" value={template} onChange={e=>setTemplate(e.target.value)} /></label><label>Idioma<input className="m-2 rounded border p-2" value={language} onChange={e=>setLanguage(e.target.value)} /></label><p className="text-xs">Si completás el nombre, se envía la plantilla en lugar del texto. Las plantillas con variables se gestionan desde Campañas.</p></details>
      <button className="rounded bg-primary p-2 text-primary-foreground disabled:opacity-50" disabled={busy||!phone||(!text.trim()&&!template)} onClick={send}>{busy?'Enviando…':'Enviar mensaje'}</button></>}
    {!lines.length&&<Link href="/lines/cloud-onboard" className="block text-primary">Conectar un número oficial →</Link>}
  </main>
}
