'use client'
import { useEffect, useRef, useState } from 'react'
import { Send, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { analyzeTemplate, buildTemplateParams, fillTemplatePreview, HEADER_LABEL, type WaTemplate } from '@/lib/template-composer'
import { CONTACT_NAME_VARIABLE } from '@/lib/campaign-personalization'

export async function broadcastRequest<T>(url:string,body?:unknown,method='POST'):Promise<T> {
  const res=await fetch(url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
  const data=await res.json().catch(()=>({error:'No se pudo leer la respuesta. Revisá Mis difusiones antes de reintentar.'}))
  if(!res.ok) throw new Error(data.error||'No se pudo completar la operación')
  return data
}
export interface BroadcastContact {id:string;firstName:string|null;lastName:string|null;phoneNumber:string}
export function PriorityBroadcastComposer({contacts,onClose,onPrepared}:{contacts:BroadcastContact[];onClose:()=>void;onPrepared:(id:string)=>void}) {
  const [templates,setTemplates]=useState<WaTemplate[]>([])
  const [loading,setLoading]=useState(true)
  const [templateId,setTemplateId]=useState('')
  const [body,setBody]=useState<string[]>([])
  const [header,setHeader]=useState('')
  const [buttons,setButtons]=useState<Record<number,string>>({})
  const [error,setError]=useState<string|null>(null)
  const [sending,setSending]=useState(false)
  const [frozen,setFrozen]=useState(false)
  const inFlight=useRef(false)
  const payload=useRef<unknown>(null)
  const [reload,setReload]=useState(0)
  useEffect(()=>{
    let disposed=false;setLoading(true);setError(null)
    broadcastRequest<{templates:WaTemplate[]}>('/api/templates?status=APROBADA',undefined,'GET')
      .then(data=>{if(!disposed)setTemplates(data.templates.filter(t=>t.status==='APROBADA'&&!!t.waba_id))})
      .catch(e=>{if(!disposed)setError(e.message)})
      .finally(()=>{if(!disposed)setLoading(false)})
    return()=>{disposed=true}
  },[reload])
  const selected=templates.find(t=>t.id===templateId)
  const analysis=selected?analyzeTemplate(selected):null
  const build=analysis?buildTemplateParams(analysis,body,header,buttons):null
  const ready=!!analysis && !analysis.unsupported.length && !!build && !build.missing.length && !build.invalid.length
  async function send() {
    if(inFlight.current || (!ready&&!payload.current)) return
    inFlight.current=true;setSending(true);setError(null);setFrozen(true)
    payload.current??={request_id:crypto.randomUUID(),contact_ids:contacts.map(c=>c.id),template_id:templateId,template_params:build!.params}
    try {
      const result=await broadcastRequest<{campaign_id:string}>('/api/contacts/prioritized/broadcasts',payload.current)
      onPrepared(result.campaign_id)
    } catch(e) {setError(e instanceof Error?e.message:'No se pudo preparar la difusión')}
    finally {inFlight.current=false;setSending(false)}
  }
  return <Dialog open onOpenChange={open=>{if(!open&&!sending)onClose()}}>
    <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto">
      <DialogHeader><DialogTitle>Difundir a {contacts.length} contactos</DialogTitle></DialogHeader>
      <p className="text-sm text-muted-foreground">Revisá los destinatarios y la plantilla. Cada contacto pasará a Difundidos cuando WhatsApp confirme el envío.</p>
      <details className="rounded-lg border p-3 text-sm">
        <summary className="cursor-pointer font-medium">Ver los {contacts.length} destinatarios seleccionados</summary>
        <ul className="mt-2 max-h-36 overflow-y-auto space-y-1">{contacts.map(c=><li key={c.id}>{[c.firstName,c.lastName].filter(Boolean).join(' ')||'Sin nombre'} · {c.phoneNumber}</li>)}</ul>
      </details>
      <fieldset disabled={sending||frozen} className="space-y-3 disabled:opacity-70">
        <label className="block text-sm font-medium" htmlFor="priority-template">Plantilla aprobada</label>
        <select id="priority-template" className="w-full rounded-lg border bg-background p-2 text-sm" value={templateId}
          onChange={e=>{setTemplateId(e.target.value);setBody([]);setHeader('');setButtons({})}}>
          <option value="">{loading?'Cargando plantillas…':'Seleccionar plantilla'}</option>
          {templates.map(t=><option key={t.id} value={t.id}>{t.name} · {t.language||'Sin idioma'}</option>)}
        </select>
        {!loading&&!templates.length&&<p className="text-sm text-muted-foreground">No hay plantillas aprobadas disponibles. Revisá el catálogo en <a href="/templates" className="underline">Plantillas</a>.</p>}
        {analysis&&<>
          {!!analysis.unsupported.length&&<p role="alert" className="text-sm text-destructive">{analysis.unsupported.join('. ')}</p>}
          {analysis.header&&<label className="block text-sm">Enlace HTTPS de {HEADER_LABEL[analysis.header]}<Input value={header} onChange={e=>setHeader(e.target.value)} placeholder="https://…" /></label>}
          {Array.from({length:analysis.bodyCount},(_,i)=><div key={i}>
            <label htmlFor={`priority-param-${i}`} className="text-sm">Valor de {`{{${i+1}}}`}</label>
            <Input id={`priority-param-${i}`} value={body[i]||''} maxLength={1024} onChange={e=>setBody(old=>{const next=[...old];next[i]=e.target.value;return next})} />
            <Button type="button" variant="outline" size="sm" className="mt-1" onClick={()=>setBody(old=>{const next=[...old];next[i]=CONTACT_NAME_VARIABLE;return next})}>Usar nombre del contacto</Button>
          </div>)}
          {analysis.buttons.map(b=><label key={b.index} className="block text-sm">{b.label} {b.required?'(valor del enlace)':'(respuesta opcional)'}
            <Input value={buttons[b.index]||''} onChange={e=>setButtons(old=>({...old,[b.index]:e.target.value}))} />
          </label>)}
          <div className="rounded-xl border bg-muted/50 p-4 space-y-2">
            <p className="text-xs font-semibold text-muted-foreground">VISTA PREVIA DEL CUERPO</p>
            <p className="whitespace-pre-wrap text-sm">{fillTemplatePreview(analysis.bodyText,body)}</p>
            {body.some(v=>v.includes(CONTACT_NAME_VARIABLE))&&<p className="text-xs text-muted-foreground">Pablo es un ejemplo; cada contacto recibe su nombre.</p>}
            {analysis.header&&<p className="text-xs text-muted-foreground">Adjunto: {header||'Falta completar el enlace'}</p>}
            {build&&[...build.missing,...build.invalid].length>0&&<p className="text-xs text-warning">Completá: {[...build.missing,...build.invalid].join(', ')}</p>}
          </div>
        </>}
      </fieldset>
      <p className="text-xs text-muted-foreground">Se respetan la línea asignada, sus horarios, los límites de envío y el tiempo entre contactos. Los pendientes y fallidos se muestran en Mis difusiones.</p>
      {error&&<div role="alert" className="text-sm text-destructive">{error}{!frozen&&<button className="underline ml-2" onClick={()=>setReload(v=>v+1)}>Recargar plantillas</button>}
        {frozen&&<p className="mt-1">Podés reintentar esta misma solicitud sin duplicarla. Para cambiar la selección, cerrá y revisá primero Mis difusiones.</p>}</div>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={sending} onClick={onClose}>Cancelar</Button>
        <Button disabled={sending||(!ready&&!frozen)} onClick={send} className="gap-2">
          {sending?<Loader2 size={16} className="animate-spin"/>:<Send size={16}/>}
          {sending?'Preparando…':frozen?'Reintentar misma difusión':`Confirmar y enviar a ${contacts.length}`}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
}
