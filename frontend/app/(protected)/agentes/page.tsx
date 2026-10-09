'use client'
import { useCallback, useEffect, useState } from 'react'
import { Plus, Pencil, Phone, Users, Loader2, Search } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { contactLineLabel, type AgentDirectoryEntry, type AgentLine } from '@/lib/agent-line-types'

type Editor = {kind:'agent';agent?:AgentDirectoryEntry} | {kind:'line';agent:AgentDirectoryEntry;line?:AgentLine}
type Fields = {code:string;name:string;linea:string;variant:string;label:string;phone:string;is_active:boolean}
const empty:Fields = {code:'',name:'',linea:'1',variant:'',label:'',phone:'',is_active:true}
async function api<T>(url:string,init?:RequestInit):Promise<T> {
  const response = await fetch(url,init)
  const body = await response.json().catch(()=>null)
  if (!response.ok) throw new Error(body?.error || 'No se pudo completar la operación. Reintentá.')
  return body
}
export default function AgentsPage() {
  const {user,loading:authLoading} = useCurrentUser()
  const [agents,setAgents] = useState<AgentDirectoryEntry[]>([])
  const [loading,setLoading] = useState(true), [error,setError] = useState('')
  const [search,setSearch] = useState(''), [selected,setSelected] = useState('')
  const [editor,setEditor] = useState<Editor|null>(null), [fields,setFields] = useState<Fields>(empty)
  const [saving,setSaving] = useState(false), [formError,setFormError] = useState(''), [notice,setNotice] = useState('')
  const load = useCallback(async()=>{
    setError(''); setLoading(true)
    try { const data=await api<{agents:AgentDirectoryEntry[]}>('/api/agents'); setAgents(data.agents) }
    catch(e) { setError((e as Error).message) }
    finally { setLoading(false) }
  },[])
  useEffect(()=>{if(user?.role==='admin') void load()},[user?.role,load])
  const open = (next:Editor) => {
    setFormError('');setNotice('');setEditor(next)
    setFields(next.kind==='agent' ? {...empty,code:next.agent?.code||'',name:next.agent?.name||''}
      : {...empty,linea:String(next.line?.linea||1),variant:next.line?.variant||'',label:next.line?.label||'',phone:next.line?.phone||'',is_active:next.line?.is_active??true})
  }
  const save = async(e:React.FormEvent) => {
    e.preventDefault(); if (!editor || saving) return
    setSaving(true);setFormError('')
    const code=editor.agent?.code || fields.code.trim().toLowerCase()
    const root='/api/agents'+(editor.kind==='agent' && !editor.agent ? '' : '/'+encodeURIComponent(code))
    const url=editor.kind==='line'?root+'/lines'+(editor.line?'/'+editor.line.id:''):root
    const body=editor.kind==='agent'
      ? {name:fields.name,...(!editor.agent?{code}: {})}
      : {label:fields.label,phone:fields.phone,is_active:fields.is_active,...(!editor.line?{linea:Number(fields.linea),variant:fields.variant}: {})}
    try {
      await api(url,{method:(editor.kind==='agent'?editor.agent:editor.line)?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      setEditor(null);setSelected(code);setNotice('Cambios guardados'); await load()
    } catch(e) {setFormError((e as Error).message)}
    finally {setSaving(false)}
  }
  if(authLoading)return <p role="status">Cargando…</p>
  if(user?.role!=='admin')return <p role="alert">Solo los administradores pueden gestionar los agentes y sus líneas.</p>
  const term=search.trim().toLowerCase()
  const shown=agents.filter(a=>(!selected||a.code===selected) && (!term || [a.code,a.name,...a.lines.flatMap(l=>[l.label,l.phone,contactLineLabel(l.linea,l.variant)])].some(v=>v.toLowerCase().includes(term))))
  return <div className="space-y-5">
    <PageHeader title="Agentes" description="Guardá los teléfonos de las líneas designadas para compartirlos desde Conversaciones."
      actions={<Button onClick={()=>open({kind:'agent'})}><Plus size={16}/>Nuevo agente</Button>}/>
    <div className="flex flex-wrap gap-3 rounded-xl border bg-card p-4">
      <div className="relative min-w-56 flex-1"><Search className="absolute left-3 top-3 text-muted-foreground" size={15}/><Input aria-label="Buscar agente o línea" className="pl-9" placeholder="Buscar agente, línea o teléfono…" value={search} onChange={e=>setSearch(e.target.value)}/></div>
      <select aria-label="Elegir agente" className="h-10 rounded-lg border border-input bg-card px-3 text-sm" value={selected} onChange={e=>setSelected(e.target.value)}>
        <option value="">Todos los agentes</option>{agents.map(a=><option key={a.code} value={a.code}>{a.name}</option>)}
      </select>
      <Button variant="outline" onClick={load} disabled={loading}>Actualizar</Button>
    </div>
    <p className="text-sm text-muted-foreground">La línea se vincula con el agente, número y variante asignados en Contactos. Las líneas inactivas no se ofrecen en los chats ni en las respuestas automáticas.</p>
    {notice&&<p role="status" className="text-sm text-success">{notice}</p>}
    {error&&<p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    {loading&&!agents.length?<p role="status">Cargando agentes…</p>:shown.map(agent=><section key={agent.code} className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div><h2 className="flex items-center gap-2 text-lg font-semibold"><Users size={18}/>{agent.name}</h2><p className="text-xs text-muted-foreground">{agent.code} · {agent.lines.length} líneas · {agent.lines.filter(l=>l.is_active).length} activas</p></div>
        <div className="flex gap-2"><Button variant="ghost" size="sm" aria-label={`Editar agente ${agent.name}`} onClick={()=>open({kind:'agent',agent})}><Pencil size={14}/>Editar agente</Button>
          <Button variant="outline" size="sm" onClick={()=>open({kind:'line',agent})} aria-label={`Agregar línea a ${agent.name}`}><Plus size={14}/>Agregar línea</Button></div>
      </div>
      {!agent.lines.length?<div className="flex items-center gap-2 p-5 text-sm text-muted-foreground"><Phone size={16}/>Todavía no hay teléfonos cargados para este agente.</div>:
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-muted/50 text-xs text-muted-foreground"><tr><th className="px-4 py-3">Asignación</th><th className="px-4 py-3">Nombre de la línea</th><th className="px-4 py-3">Teléfono</th><th className="px-4 py-3">Estado</th><th className="px-4 py-3 text-right">Acciones</th></tr></thead>
        <tbody>{agent.lines.map(line=><tr key={line.id} className="border-t"><td className="whitespace-nowrap px-4 py-3 font-medium">{contactLineLabel(line.linea,line.variant)}</td><td className="px-4 py-3">{line.label}</td><td className="select-text whitespace-nowrap px-4 py-3 font-mono">{line.phone}</td><td className="px-4 py-3"><span className={line.is_active?'text-success':'text-muted-foreground'}>{line.is_active?'Activa':'Inactiva'}</span></td><td className="px-4 py-3 text-right"><Button variant="ghost" size="sm" aria-label={`Editar ${agent.name} ${contactLineLabel(line.linea,line.variant)}`} onClick={()=>open({kind:'line',agent,line})}><Pencil size={14}/>Editar</Button></td></tr>)}</tbody></table></div>}
    </section>)}
    {!loading&&!error&&!shown.length&&<p className="p-5 text-center text-muted-foreground">No se encontraron agentes o líneas.</p>}
    <Dialog open={!!editor} onOpenChange={value=>{if(!value&&!saving)setEditor(null)}}>
      <DialogContent showCloseButton={!saving}>
        <DialogHeader><DialogTitle>{editor?.kind==='agent'?(editor.agent?'Editar agente':'Nuevo agente'):(editor?.line?'Editar línea':'Agregar línea')}</DialogTitle>
          <DialogDescription>{editor?.kind==='agent'?'El identificador debe coincidir con el agente asignado en Contactos.':`Líneas de ${editor?.agent.name||''}. Ingresá el teléfono completo, con código de país.`}</DialogDescription></DialogHeader>
        <form onSubmit={save} className="space-y-4">
          {editor?.kind==='agent'?<>
            <label className="block space-y-1 text-sm">Nombre del agente<Input required maxLength={100} value={fields.name} onChange={e=>setFields({...fields,name:e.target.value})}/></label>
            <label className="block space-y-1 text-sm">Identificador en Contactos<Input required maxLength={100} disabled={!!editor.agent} placeholder="royal" value={fields.code} onChange={e=>setFields({...fields,code:e.target.value})}/></label>
          </>:<>
            <div className="grid grid-cols-2 gap-3"><label className="block space-y-1 text-sm">Número de línea<Input type="number" min={1} max={100} required disabled={!!editor?.line} value={fields.linea} onChange={e=>setFields({...fields,linea:e.target.value})}/></label>
              <label className="block space-y-1 text-sm">Variante<select className="h-10 w-full rounded-lg border border-input bg-card px-3" disabled={!!editor?.line} value={fields.variant} onChange={e=>setFields({...fields,variant:e.target.value})}><option value="">Sin variante</option><option value="a">A</option><option value="b">B</option><option value="c">C</option></select></label></div>
            <label className="block space-y-1 text-sm">Nombre de la línea<Input required maxLength={100} placeholder="Royal línea 8" value={fields.label} onChange={e=>setFields({...fields,label:e.target.value})}/></label>
            <label className="block space-y-1 text-sm">Teléfono<Input type="tel" required maxLength={40} placeholder="+5491123456789" value={fields.phone} onChange={e=>setFields({...fields,phone:e.target.value})}/></label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={fields.is_active} onChange={e=>setFields({...fields,is_active:e.target.checked})}/>Línea activa</label>
          </>}
          {formError&&<p role="alert" className="text-sm text-destructive">{formError}</p>}
          <DialogFooter><Button type="button" variant="outline" disabled={saving} onClick={()=>setEditor(null)}>Cancelar</Button><Button type="submit" disabled={saving}>{saving?<><Loader2 size={14} className="animate-spin"/>Guardando…</>:'Guardar'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
}
