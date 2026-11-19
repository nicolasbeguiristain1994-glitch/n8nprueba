'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Copy, Link2, Loader2, RefreshCw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { SUBSCRIPTION_PRESETS, subscriptionMessageError, defaultSubscriptionFlow, type SubscriptionConfirmationFlow } from '@/lib/line-subscription-message'

interface Line { id:string;display_name:string;phone_number:string|null;line_type:string;brand_name:string|null;enabled:boolean|null;can_edit:boolean }
interface Settings {brand_name:string;message_text:string;enabled:boolean;confirmation_flow?:SubscriptionConfirmationFlow|null}
interface Consent {id:string;contact_phone:string;status:string;message_text:string;expected_message:string;brand_name:string;provider:string;message_id:string;occurred_at:string;recorded_at:string}
interface Detail {line:Line;settings:Settings|null;link:string|null;stats:{subscribed:number;unsubscribed:number;pending?:number;renewal_required:number};records:Consent[];hasMore:boolean}
const emptyForm:Settings = {brand_name:'',message_text:'',enabled:true,confirmation_flow:null}

async function readResponse(response:Response) {
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'No se pudo completar la operación.')
  return body
}

export default function LineSubscriptionsPage() {
  const {permissions} = useCurrentUser()
  const [lines,setLines] = useState<Line[]>([])
  const [lineId,setLineId] = useState('')
  const [detail,setDetail] = useState<Detail|null>(null)
  const [form,setForm] = useState<Settings>(emptyForm)
  const [preset,setPreset] = useState('')
  const [view,setView] = useState('all')
  const [page,setPage] = useState(0)
  const [loading,setLoading] = useState(true)
  const [saving,setSaving] = useState(false)
  const [error,setError] = useState('')
  const [notice,setNotice] = useState('')
  const [refresh,setRefresh] = useState(0)
  const loadedLine = useRef('')
  const requestId = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/lines/subscriptions',{signal:controller.signal,cache:'no-store'}).then(readResponse).then(data => {
      setLines(data.lines)
      const requested = new URLSearchParams(window.location.search).get('lineId')
      setLineId(data.lines.find((line:Line) => line.id===requested)?.id ?? data.lines[0]?.id ?? '')
      if (!data.lines.length) setLoading(false)
    }).catch(err => { if (!controller.signal.aborted) {setError(err.message);setLoading(false)} })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!lineId) return
    const controller = new AbortController()
    const id = ++requestId.current
    setLoading(true);setError('')
    fetch(`/api/lines/subscriptions?lineId=${encodeURIComponent(lineId)}&view=${view}&page=${page}`,
      {signal:controller.signal,cache:'no-store'}).then(readResponse).then(data => {
      if (id!==requestId.current) return
      setDetail(data);setLines(data.lines)
      if (loadedLine.current!==lineId) {
        setForm(data.settings ?? {...emptyForm,brand_name:data.line.display_name ?? ''})
        setPreset('');loadedLine.current=lineId
      }
    }).catch(err => {if(!controller.signal.aborted) setError(err.message)})
      .finally(() => {if(!controller.signal.aborted && id===requestId.current) setLoading(false)})
    return () => controller.abort()
  }, [lineId,view,page,refresh])

  const current = detail?.line.id===lineId ? detail : null
  const editable = !!current?.line.can_edit && !!permissions.lines?.includes('update')
  const dirty = !!current && (form.brand_name!==(current.settings?.brand_name ?? '')
    || form.message_text!==(current.settings?.message_text ?? '') || form.enabled!==(current.settings?.enabled ?? true)
    || JSON.stringify(form.confirmation_flow??null)!==JSON.stringify(current.settings?.confirmation_flow??null))
  const link = !dirty ? current?.link : null

  const changeLine = (id:string) => {
    if (id===lineId) return
    setLineId(id);setDetail(null);setPage(0);setForm(emptyForm);setNotice('');setError('');loadedLine.current=''
  }
  const save = async () => {
    const validation = subscriptionMessageError(form.brand_name,form.message_text)
    if (validation) {setError(validation);return}
    setSaving(true);setError('');setNotice('')
    try {
      const data = await fetch('/api/lines/subscriptions',{method:'PUT',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({lineId,brandName:form.brand_name,message:form.message_text,enabled:form.enabled,confirmationFlow:form.confirmation_flow??null})}).then(readResponse)
      setForm(data.settings)
      setDetail(previous => previous ? {...previous,settings:data.settings,link:data.link} : previous)
      setNotice(data.settings.enabled ? 'Configuración guardada. Ya podés copiar el enlace.' : 'Nuevas altas desactivadas. Las bajas y el control de campañas siguen vigentes.');setRefresh(n=>n+1)
    } catch(err) {setError(err instanceof Error ? err.message : 'No se pudo guardar.')}
    finally {setSaving(false)}
  }
  const copy = useCallback(async () => {
    if (!link) return
    try {await navigator.clipboard.writeText(link);setNotice('Enlace copiado.')}
    catch {setError('No se pudo copiar. Podés seleccionar y copiar el enlace del campo.')}
  }, [link])

  return <div className="space-y-5 max-w-7xl mx-auto">
    <Link href="/lines" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft size={16}/> Volver a Líneas</Link>
    <div className="flex items-start justify-between gap-3">
      <div><h1 className="page-title">Suscripciones por WhatsApp</h1>
        <p className="text-sm text-muted-foreground mt-1">Prepará el mensaje de cada línea, compartí el enlace y consultá las autorizaciones y bajas.</p></div>
      <Button variant="outline" size="sm" disabled={loading||saving||!lineId} onClick={()=>setRefresh(n=>n+1)} aria-label="Actualizar registros"><RefreshCw size={16}/></Button>
    </div>
    {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="rounded-lg bg-primary/10 p-3 text-sm">{notice}</p>}
    <div className="max-w-lg space-y-2"><label htmlFor="subscription-line" className="text-sm font-medium">Línea de WhatsApp</label>
      <select id="subscription-line" value={lineId} disabled={saving} onChange={event=>changeLine(event.target.value)} className="w-full rounded-md border bg-background p-2 text-sm">
        {!lines.length && <option value="">Sin líneas disponibles</option>}
        {lines.map(line=><option key={line.id} value={line.id}>{line.display_name} · {line.phone_number || 'Sin número'} · {line.line_type==='cloud'?'Cloud API':'QR'}</option>)}
      </select></div>
    {loading && !current && <p role="status" className="flex gap-2 text-sm"><Loader2 size={16} className="animate-spin"/> Cargando suscripciones…</p>}
    {!loading && !lines.length && !error && <p className="text-sm text-muted-foreground">Agregá una línea desde Líneas para configurar su suscripción.</p>}
    {current && <>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card><CardContent className="pt-5 space-y-4">
          <h2 className="font-semibold">Mensaje de autorización</h2>
          <div className="space-y-2"><label htmlFor="subscription-brand" className="text-sm font-medium">Marca o negocio</label>
            <Input id="subscription-brand" value={form.brand_name} maxLength={100} disabled={!editable||saving} onChange={e=>setForm({...form,brand_name:e.target.value})} placeholder="Nombre del negocio"/>
            <p className="text-xs text-muted-foreground">Identifica el negocio en los registros del panel. No es obligatorio repetir este nombre en el mensaje del cliente.</p></div>
          <div className="space-y-2"><label htmlFor="subscription-preset" className="text-sm font-medium">Usar un ejemplo</label>
            <select id="subscription-preset" value={preset} disabled={!editable||saving} className="w-full rounded-md border bg-background p-2 text-sm" onChange={e=>{
              const value=e.target.value;setPreset(value)
              if (value) setForm({...form,message_text:SUBSCRIPTION_PRESETS[value as keyof typeof SUBSCRIPTION_PRESETS].replace('{marca}',form.brand_name.trim()||'[MARCA]')})
            }}><option value="">Mensaje personalizado</option><option value="clothing">Indumentaria · hasta 2 veces por semana</option><option value="solar">Energía solar · hasta 2 veces al mes</option><option value="general">Novedades y promociones</option><option value="withoutBrand">Novedades y promociones · sin nombre de marca</option></select></div>
          <div className="space-y-2"><label htmlFor="subscription-message" className="text-sm font-medium">Mensaje que enviará el cliente</label>
            <Textarea id="subscription-message" rows={6} maxLength={1000} value={form.message_text} disabled={!editable||saving}
              onChange={e=>{setForm({...form,message_text:e.target.value});setPreset('')}} placeholder="Quiero recibir promociones por WhatsApp. Puedo cancelar escribiendo BAJA."/>
            <p className="text-xs text-muted-foreground">{form.message_text.length}/1000. Indicá qué acepta recibir y cómo darse de baja. Si omitís el nombre en este mensaje, identificá claramente el negocio en el estado o formulario donde compartís el enlace. Respetá la frecuencia anunciada.</p></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} disabled={!editable||saving} onChange={e=>setForm({...form,enabled:e.target.checked})}/> Registrar nuevas autorizaciones</label>
          {current.line.line_type==='cloud' && <div className="rounded-lg border p-4 space-y-3">
            <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={!!form.confirmation_flow} disabled={!editable||saving}
              onChange={e=>setForm({...form,confirmation_flow:e.target.checked?defaultSubscriptionFlow(form.brand_name.trim()):null})}/> Confirmación en dos pasos con OK</label>
            <p className="text-xs text-muted-foreground">El mensaje del enlace deja el alta pendiente. Solo un OK posterior autoriza promociones de esta línea. BAJA cancela el alta y la suscripción de esta línea.</p>
            {form.confirmation_flow && (['welcome','confirmation','goodbye'] as const).map((field,index)=><div key={field} className="space-y-2">
              <label htmlFor={`subscription-${field}`} className="text-sm font-medium">{['Bienvenida automática','Confirmación automática','Respuesta de baja'][index]}</label>
              <Textarea id={`subscription-${field}`} rows={3} maxLength={3000} disabled={!editable||saving} value={form.confirmation_flow![field]}
                onChange={e=>setForm({...form,confirmation_flow:{...form.confirmation_flow!,[field]:e.target.value}})}/>
            </div>)}
            {!!form.confirmation_flow && <p className="text-xs text-muted-foreground">La bienvenida admite {'{{nombre}}'}. Si falta el nombre, «¡Hola, {'{{nombre}}'}!» se convierte en «¡Hola!».</p>}
          </div>}
          <p className="text-xs text-muted-foreground">Las altas se reconocen por el texto completo recibido. Si cambiás la marca o el mensaje, publicá el nuevo enlace y solicitá una nueva autorización. Las anteriores quedan en el historial y no habilitan campañas con el nuevo texto.</p>
          <Button onClick={save} disabled={!editable||saving||!dirty}>{saving?<Loader2 size={16} className="mr-2 animate-spin"/>:<Save size={16} className="mr-2"/>} Guardar configuración</Button>
          {!editable && <p className="text-xs text-muted-foreground">Tu acceso a esta línea es de consulta.</p>}
        </CardContent></Card>
        <Card><CardContent className="pt-5 space-y-4">
          <h2 className="font-semibold flex items-center gap-2"><Link2 size={18}/> Enlace de suscripción</h2>
          <p className="text-sm text-muted-foreground">Compartilo en estados, redes o tu sitio. El enlace abre el chat de {current.line.display_name} con el mensaje preparado.</p>
          <div className="rounded-xl border bg-muted/30 p-4"><p className="text-xs font-medium mb-2">Vista previa del mensaje</p><p className="text-sm whitespace-pre-wrap break-words">{form.message_text || 'Elegí un ejemplo o escribí tu mensaje.'}</p></div>
          <label htmlFor="subscription-link" className="sr-only">Enlace generado</label>
          <Input id="subscription-link" readOnly value={link ?? ''} placeholder={dirty?'Guardá los cambios para generar el enlace':'Las nuevas autorizaciones están desactivadas'} onFocus={e=>e.target.select()}/>
          <Button variant="outline" disabled={!link||saving} onClick={copy}><Copy size={16} className="mr-2"/> Copiar enlace</Button>
          <div className="rounded-lg border p-4 text-sm space-y-2">
            <p><strong>Alta:</strong> {form.confirmation_flow?'el mensaje completo inicia una solicitud pendiente. La autorización se registra cuando el cliente responde OK.':'se registra cuando el cliente envía el mensaje completo.'} Un clic o un “Hola” no lo suscribe.</p>
            <p><strong>BAJA:</strong> {form.confirmation_flow?'cancela la solicitud pendiente y desactiva las promociones de esta línea.':'registra la baja y mantiene el bloqueo de envíos del panel.'} Los bloqueos previos de Blacklist requieren su propia revisión.</p>
            <p><strong>Campañas:</strong> desde que guardás esta configuración, la línea requiere su propia autorización antes de enviar. Desactivar nuevas altas no elimina las bajas ni esta protección.</p>
            <p className="text-muted-foreground">La recepción automática requiere el webhook de la línea conectado al panel. Los bloqueos manuales existentes se conservan.</p>
          </div>
        </CardContent></Card>
      </div>
      <Card><CardContent className="pt-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">Autorizaciones y bajas</h2>
          <p className="text-sm text-muted-foreground">{current.stats.subscribed} suscriptos · {current.stats.pending??0} pendientes de OK · {current.stats.unsubscribed} bajas · {current.stats.renewal_required} por renovar en esta línea</p></div>
          <select aria-label="Filtrar registros" value={view} onChange={e=>{setView(e.target.value);setPage(0)}} className="rounded-md border bg-background p-2 text-sm">
            <option value="all">Estado actual · todos</option><option value="subscribed">Suscriptos</option><option value="pending">Pendientes de OK</option><option value="unsubscribed">Bajas</option><option value="renewal_required">Por renovar</option><option value="history">Historial de eventos</option>
          </select></div>
        {loading ? <p role="status" className="text-sm">Actualizando registros…</p> : current.records.length===0 ? <p className="text-sm text-muted-foreground py-5">Todavía no hay registros para este filtro.</p> :
          <div className="divide-y">{current.records.map(record=><div key={record.id} className="py-3 space-y-1">
            <div className="flex flex-wrap justify-between gap-2 text-sm"><span className="font-medium">+{record.contact_phone}</span>
              <span className={record.status==='subscribed'?'text-success':record.status==='unsubscribed'?'text-destructive':'text-muted-foreground'}>{record.status==='subscribed'?'Autorizado':record.status==='unsubscribed'?'Baja':record.status==='pending'?'Pendiente de OK':'Por renovar'}</span></div>
            <p className="text-xs text-muted-foreground">{record.brand_name} · {new Date(record.occurred_at).toLocaleString('es-AR')} · {record.provider==='cloud'?'Cloud API':'WhatsApp QR'}</p>
            <details className="text-sm"><summary className="cursor-pointer text-primary">Ver mensaje recibido</summary><p className="whitespace-pre-wrap break-words mt-2 rounded-md bg-muted p-3">{record.message_text}</p></details>
          </div>)}</div>}
        <div className="flex items-center justify-between text-sm"><span>Página {page+1} · hasta 50 registros</span><div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={page===0||loading} onClick={()=>setPage(n=>n-1)}>Anterior</Button>
          <Button size="sm" variant="outline" disabled={!current.hasMore||loading} onClick={()=>setPage(n=>n+1)}>Siguiente</Button>
        </div></div>
      </CardContent></Card>
    </>}
  </div>
}
