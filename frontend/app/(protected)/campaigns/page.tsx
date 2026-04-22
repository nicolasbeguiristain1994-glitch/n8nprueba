'use client'
import { useEffect, useState, useCallback } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Send, Plus, Loader2, Eye, Play, BarChart2, Shield, Clock, Pause, XCircle, CheckCheck, Truck, AlertTriangle, HelpCircle, Trash2, Shuffle, UserCheck, UserX } from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'

interface CampaignList { id: string; name: string; contact_count: number }
interface CampaignContact {
  id: string; first_name: string; last_name: string; phone_number: string
  msg_status: string | null; sent_at: string | null
  delivered_at: string | null; read_at: string | null
  failed_at: string | null; error_detail: string | null
}
interface Campaign {
  id: string; name: string; message: string; messages: string[]; status: string
  scheduled_at: string; completed_at: string
  total_targets: number; total_sent: number; total_delivered: number
  total_read: number; total_failed: number
  read_rate: number; delivery_rate: number
  list_name: string; antiblock_delay_min: number; antiblock_delay_max: number
  personalize_name: boolean; created_at: string
}

const STATUS_BADGE: Record<string, string> = {
  draft:      'bg-gray-100 text-gray-600',
  scheduled:  'bg-blue-100 text-blue-700',
  running:    'bg-yellow-100 text-yellow-700',
  completed:  'bg-green-100 text-green-700',
  paused:     'bg-orange-100 text-orange-700',
  cancelled:  'bg-red-100 text-red-600',
}

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [lists, setLists]         = useState<CampaignList[]>([])
  const [showNew, setShowNew]     = useState(false)
  const [selected, setSelected]       = useState<Campaign | null>(null)
  const [campContacts, setCampContacts] = useState<CampaignContact[]>([])
  const [loadingContacts, setLoadingContacts] = useState(false)
  const [sending, setSending]         = useState<string | null>(null)
  const [sendError, setSendError]     = useState<string | null>(null)
  const [actioning, setActioning]     = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)

  // Form
  const [form, setForm] = useState({
    name: '', list_id: '', scheduled_at: '',
    media_url: '', antiblock_delay_min: 3, antiblock_delay_max: 8,
    type: 'promotion', personalize_name: true
  })
  const [messages, setMessages] = useState<string[]>([''])
  const [previewIdx, setPreviewIdx] = useState(0)
  const [creating, setCreating] = useState(false)

  const load = useCallback(() => {
    fetchJson<{ campaigns: Campaign[] }>('/api/campaigns')
      .then(d => setCampaigns(d.campaigns || []))
      .catch(() => setCampaigns([]))
    fetchJson<{ lists: CampaignList[] }>('/api/lists')
      .then(d => setLists(d.lists || []))
      .catch(() => setLists([]))
  }, [])

  useEffect(() => { load() }, [load])

  const createCampaign = async () => {
    setCreating(true)
    setCreateError(null)
    const validMsgs = messages.filter(m => m.trim())
    let res: Response
    try {
      res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, messages: validMsgs, message: validMsgs[0] }),
      })
    } catch {
      setCreating(false)
      setCreateError('Error de red al crear la campaña')
      return
    }
    setCreating(false)
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      setCreateError(d.error || `Error ${res.status}`)
      return  // keep modal open, preserve form state
    }
    setShowNew(false)
    setForm({ name:'', list_id:'', scheduled_at:'', media_url:'', antiblock_delay_min:3, antiblock_delay_max:8, type:'promotion', personalize_name: true })
    setMessages([''])
    setPreviewIdx(0)
    load()
  }

  const addMessage    = () => { if (messages.length < 10) setMessages(m => [...m, '']) }
  const removeMessage = (i: number) => setMessages(m => m.filter((_, idx) => idx !== i))
  const updateMessage = (i: number, val: string) => setMessages(m => m.map((v, idx) => idx === i ? val : v))

  const sendNow = async (id: string) => {
    setSending(id)
    setSendError(null)
    try {
      const res = await fetch(`/api/campaigns/${id}/send`, { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setSendError(d.error || `Error ${res.status}`)
      } else {
        setTimeout(load, 1000)
      }
    } catch {
      setSendError('Error de red al enviar')
    } finally {
      setSending(null)
    }
  }

  const openDetail = async (c: Campaign) => {
    setSelected(c)
    setCampContacts([])
    setDetailError(null)
    setLoadingContacts(true)
    try {
      const res = await fetch(`/api/campaigns/${c.id}/contacts`)
      setLoadingContacts(false)
      if (!res.ok) { setDetailError('No se pudieron cargar los destinatarios'); return }
      const d = await res.json()
      setCampContacts(d.contacts || [])
    } catch {
      setLoadingContacts(false)
      setDetailError('Error de red al cargar destinatarios')
    }
  }

  const updateStatus = async (id: string, status: 'paused' | 'cancelled' | 'draft') => {
    setActioning(id)
    try {
      const res = await fetch(`/api/campaigns/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setSendError(d.error || `Error al actualizar estado`)
      } else {
        load()
      }
    } catch {
      setSendError('Error de red al actualizar estado')
    }
    setActioning(null)
  }

  const previewName = form.personalize_name ? 'Juan' : ''
  const previewMsg = (messages[previewIdx] || '').replace(/\{\{nombre\}\}/gi, previewName).replace(/\{\{name\}\}/gi, previewName)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Campañas</h1>
          <p className="text-sm text-gray-500">{campaigns.length} campañas</p>
        </div>
        <Button onClick={() => setShowNew(true)} className="bg-green-600 hover:bg-green-700" size="sm">
          <Plus size={14} className="mr-1" /> Nueva campaña
        </Button>
      </div>

      {/* Error de envío */}
      {sendError && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2 text-sm text-red-600 flex items-center justify-between">
          <span>{sendError}</span>
          <button onClick={() => setSendError(null)} className="ml-4 text-red-400 hover:text-red-600">✕</button>
        </div>
      )}

      {/* Lista de campañas */}
      {campaigns.length === 0
        ? <Card><CardContent className="py-16 text-center text-gray-400">
            <BarChart2 size={32} className="mx-auto mb-3 opacity-30" />
            <p>No hay campañas todavía</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => setShowNew(true)}>Crear la primera</Button>
          </CardContent></Card>
        : <div className="space-y-3">
            {campaigns.map(c => (
              <Card key={c.id} className="hover:shadow-sm transition-shadow">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[c.status] || ''}`}>
                          {c.status}
                        </span>
                        {c.scheduled_at && c.status === 'scheduled' && (
                          <span className="text-xs text-gray-400 flex items-center gap-1">
                            <Clock size={11}/> {new Date(c.scheduled_at).toLocaleString('es-AR')}
                          </span>
                        )}
                      </div>
                      <h3 className="font-medium truncate">{c.name}</h3>
                      <div className="flex items-center gap-2">
                        <p className="text-sm text-gray-500 truncate">{c.message}</p>
                        {Array.isArray(c.messages) && c.messages.length > 1 && (
                          <span className="text-xs bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-full whitespace-nowrap flex items-center gap-1 shrink-0">
                            <Shuffle size={10} /> {c.messages.length} variantes
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
                        {c.list_name && <span>Lista: <b className="text-gray-600">{c.list_name}</b></span>}
                        <span>{c.total_targets} dest.</span>
                        <span className="flex items-center gap-1"><Shield size={10}/> {c.antiblock_delay_min}-{c.antiblock_delay_max}s</span>
                        {c.personalize_name
                          ? <span className="flex items-center gap-1 text-green-600"><UserCheck size={10}/> con nombre</span>
                          : <span className="flex items-center gap-1 text-gray-400"><UserX size={10}/> sin nombre</span>
                        }
                      </div>
                    </div>

                    {/* Métricas inline */}
                    {c.total_sent > 0 && (
                      <div className="flex gap-4 text-center shrink-0">
                        <MiniStat label="Enviados" value={c.total_sent} color="blue" />
                        <MiniStat label="Entregados" value={c.total_delivered} color="green" />
                        <MiniStat label="Leídos" value={c.total_read} pct={c.read_rate} color="purple" />
                        <MiniStat label="Fallidos" value={c.total_failed} color="red" />
                      </div>
                    )}

                    <div className="flex gap-2 shrink-0">
                      <Button variant="outline" size="sm" onClick={() => openDetail(c)}>
                        <Eye size={13} />
                      </Button>

                      {/* Enviar: draft, scheduled, paused */}
                      {(c.status === 'draft' || c.status === 'scheduled' || c.status === 'paused') && c.list_name && (
                        <Button size="sm" className="bg-green-600 hover:bg-green-700"
                                onClick={() => sendNow(c.id)} disabled={sending === c.id}>
                          {sending === c.id
                            ? <Loader2 size={13} className="animate-spin"/>
                            : <><Play size={13} className="mr-1"/>{c.status === 'paused' ? 'Reanudar' : 'Enviar'}</>}
                        </Button>
                      )}

                      {/* Pausar: solo running */}
                      {c.status === 'running' && (
                        <Button size="sm" variant="outline"
                                className="border-orange-200 text-orange-600 hover:bg-orange-50"
                                onClick={() => updateStatus(c.id, 'paused')}
                                disabled={actioning === c.id}>
                          {actioning === c.id
                            ? <Loader2 size={13} className="animate-spin"/>
                            : <><Pause size={13} className="mr-1"/>Pausar</>}
                        </Button>
                      )}

                      {/* Cancelar: draft, scheduled, running, paused */}
                      {['draft','scheduled','running','paused'].includes(c.status) && (
                        <Button size="sm" variant="outline"
                                className="border-red-200 text-red-500 hover:bg-red-50"
                                onClick={() => { if (confirm(`¿Cancelar "${c.name}"?`)) updateStatus(c.id, 'cancelled') }}
                                disabled={actioning === c.id}>
                          <XCircle size={13} />
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Barra de progreso */}
                  {c.status === 'running' && c.total_targets > 0 && (
                    <div className="mt-3">
                      <div className="flex justify-between text-xs text-gray-400 mb-1">
                        <span>Enviando…</span>
                        <span>{c.total_sent}/{c.total_targets}</span>
                      </div>
                      <div className="w-full bg-gray-100 rounded-full h-1.5">
                        <div className="bg-green-500 h-1.5 rounded-full transition-all"
                             style={{ width: `${(c.total_sent/c.total_targets)*100}%` }} />
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
      }

      {/* Modal nueva campaña */}
      <Dialog open={showNew} onOpenChange={v => {
        if (creating) return  // block close while save is in progress
        setShowNew(v)
        if (!v) {
          setForm({ name:'', list_id:'', scheduled_at:'', media_url:'', antiblock_delay_min:3, antiblock_delay_max:8, type:'promotion', personalize_name: true })
          setMessages([''])
          setPreviewIdx(0)
          setCreating(false)
          setCreateError(null)
          setSendError(null)
        }
      }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Nueva campaña</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="text-xs font-medium text-gray-600 mb-1 block">Nombre de la campaña</label>
              <Input placeholder="Ej: Promo Abril 2026" value={form.name} onChange={e => setForm(f=>({...f,name:e.target.value}))} />
            </div>

            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Tipo de campaña</label>
              <Select value={form.type} onValueChange={v => setForm(f=>({...f,type:v ?? 'promotion'}))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[['promotion','Promoción'],['retention','Retención'],['onboarding','Onboarding'],['support','Soporte'],['survey','Encuesta'],['payment','Cobro'],['risk_alert','Alerta']].map(([val,label]) => (
                    <SelectItem key={val} value={val}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Lista de distribución</label>
              <Select value={form.list_id} onValueChange={v => setForm(f=>({...f,list_id:v ?? ''}))}>
                <SelectTrigger><SelectValue placeholder="Seleccioná una lista" /></SelectTrigger>
                <SelectContent>
                  {lists.map(l => <SelectItem key={l.id} value={l.id}>{l.name} ({l.contact_count} contactos)</SelectItem>)}
                </SelectContent>
              </Select>
              {lists.length === 0 && <p className="text-xs text-orange-500 mt-1">Creá primero una lista en Contactos</p>}
            </div>

            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">
                <Clock size={12} className="inline mr-1"/>Programar envío (opcional)
              </label>
              <Input type="datetime-local" value={form.scheduled_at} onChange={e => setForm(f=>({...f,scheduled_at:e.target.value}))} />
            </div>

            {/* Mensajes con variantes */}
            <div className="col-span-2 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-gray-600">
                  Mensajes{' '}
                  <span className="text-gray-400 font-normal">(usá {'{{nombre}}'} para personalizar)</span>
                </label>
                <div className="flex items-center gap-2">
                  {messages.length > 1 && (
                    <span className="text-xs text-indigo-600 flex items-center gap-1">
                      <Shuffle size={11} /> Se envían aleatoriamente
                    </span>
                  )}
                  <span className="text-xs text-gray-400">{messages.length}/10</span>
                </div>
              </div>

              {messages.map((msg, i) => (
                <div key={i} className="relative group">
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-gray-500">
                          Variante {i + 1}
                          {messages.length > 1 && (
                            <button
                              type="button"
                              onClick={() => setPreviewIdx(i)}
                              className={`ml-2 text-xs underline ${previewIdx === i ? 'text-indigo-600 font-medium' : 'text-gray-400'}`}
                            >
                              {previewIdx === i ? 'previsualizando' : 'previsualizar'}
                            </button>
                          )}
                        </span>
                        <span className="text-xs text-gray-400">{msg.length} car.</span>
                      </div>
                      <Textarea
                        placeholder={i === 0 ? 'Hola {{nombre}}, tenemos una oferta especial…' : `Variante alternativa ${i + 1}…`}
                        rows={3}
                        value={msg}
                        onChange={e => updateMessage(i, e.target.value)}
                        className="resize-none"
                      />
                    </div>
                    {messages.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeMessage(i)}
                        className="mt-6 text-gray-300 hover:text-red-400 transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))}

              {messages.length < 10 && (
                <button
                  type="button"
                  onClick={addMessage}
                  className="w-full border-2 border-dashed border-gray-200 rounded-lg py-2 text-xs text-gray-400 hover:border-indigo-300 hover:text-indigo-500 transition-colors flex items-center justify-center gap-1.5"
                >
                  <Plus size={13} /> Agregar variante de mensaje
                </button>
              )}
            </div>

            {/* Personalización de nombre */}
            <div className="col-span-2">
              <button
                type="button"
                onClick={() => setForm(f => ({ ...f, personalize_name: !f.personalize_name }))}
                className={`flex items-center gap-3 w-full rounded-lg border px-4 py-3 text-sm transition-colors ${
                  form.personalize_name
                    ? 'border-green-200 bg-green-50 text-green-800'
                    : 'border-gray-200 bg-gray-50 text-gray-500'
                }`}
              >
                <div className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${form.personalize_name ? 'bg-green-500' : 'bg-gray-300'}`}>
                  <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${form.personalize_name ? 'translate-x-4' : ''}`} />
                </div>
                {form.personalize_name
                  ? <><UserCheck size={15} className="shrink-0" /><span>Nombre personalizado activado — <code className="bg-green-100 px-1 rounded">{'{{nombre}}'}</code> se reemplaza con el nombre de cada contacto</span></>
                  : <><UserX size={15} className="shrink-0" /><span>Nombre personalizado desactivado — <code className="bg-gray-100 px-1 rounded">{'{{nombre}}'}</code> se omite del mensaje</span></>
                }
              </button>
            </div>

            {/* Preview */}
            {messages[previewIdx]?.trim() && (
              <div className="col-span-2 bg-gray-50 rounded-lg p-3">
                <p className="text-xs font-medium text-gray-500 mb-2">
                  Preview — Variante {previewIdx + 1}
                </p>
                <div className="inline-block bg-green-500 text-white text-sm px-3 py-2 rounded-2xl rounded-bl-sm max-w-xs">
                  {previewMsg}
                </div>
              </div>
            )}

            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">URL de media (opcional)</label>
              <Input placeholder="https://…" value={form.media_url} onChange={e => setForm(f=>({...f,media_url:e.target.value}))} />
            </div>

            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">
                <Shield size={12} className="inline mr-1"/>Antibloqueo — delay entre mensajes (seg)
              </label>
              <div className="flex gap-2 items-center">
                <Input type="number" className="w-20" min={1} max={60} value={form.antiblock_delay_min}
                  onChange={e => setForm(f=>({...f,antiblock_delay_min:Number(e.target.value)}))} />
                <span className="text-gray-400 text-sm">a</span>
                <Input type="number" className="w-20" min={1} max={120} value={form.antiblock_delay_max}
                  onChange={e => setForm(f=>({...f,antiblock_delay_max:Number(e.target.value)}))} />
                <span className="text-gray-400 text-xs">segundos</span>
              </div>
            </div>

            {createError && (
              <div className="col-span-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-600 flex items-center justify-between">
                <span>{createError}</span>
                <button onClick={() => setCreateError(null)} className="ml-3 text-red-400 hover:text-red-600">✕</button>
              </div>
            )}
            <div className="col-span-2 flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setShowNew(false)} disabled={creating}>Cancelar</Button>
              <Button className="flex-1 bg-green-600 hover:bg-green-700" onClick={createCampaign}
                      disabled={creating || !form.name || !messages.some(m => m.trim())}>
                {creating ? <Loader2 size={14} className="mr-1 animate-spin"/> : <Send size={14} className="mr-1"/>}
                {form.scheduled_at ? 'Programar campaña' : 'Guardar campaña'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal detalle campaña */}
      <Dialog open={!!selected} onOpenChange={() => { setSelected(null); setDetailError(null) }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selected?.name}
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[selected?.status || ''] || 'bg-gray-100 text-gray-600'}`}>
                {selected?.status}
              </span>
            </DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4">
              {/* Métricas */}
              <div className="grid grid-cols-4 gap-3 text-center">
                <StatBox label="Enviados"    value={selected.total_sent}      color="blue"   />
                <StatBox label="Entregados"  value={selected.total_delivered} color="green"  />
                <StatBox label="Leídos"      value={selected.total_read}      color="purple" pct={selected.read_rate} />
                <StatBox label="Fallidos"    value={selected.total_failed}    color="red"    />
              </div>

              {selected.total_targets > 0 && (
                <div className="space-y-2">
                  <ProgressBar label="Tasa de entrega" value={selected.delivery_rate} color="green" />
                  <ProgressBar label="Tasa de lectura" value={selected.read_rate}     color="purple" />
                </div>
              )}

              {/* Mensajes */}
              <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-2">
                <p className="font-medium text-gray-700 flex items-center gap-2">
                  Mensaje{Array.isArray(selected.messages) && selected.messages.length > 1 && (
                    <span className="text-xs bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-full flex items-center gap-1">
                      <Shuffle size={10} /> {selected.messages.length} variantes aleatorias
                    </span>
                  )}
                </p>
                {(Array.isArray(selected.messages) && selected.messages.length > 1
                  ? selected.messages
                  : [selected.message]
                ).map((msg, i) => (
                  <div key={i} className="flex gap-2">
                    {selected.messages?.length > 1 && (
                      <span className="text-xs text-gray-400 shrink-0 mt-0.5">#{i + 1}</span>
                    )}
                    <p className="text-gray-600">{msg}</p>
                  </div>
                ))}
              </div>

              <div className="text-xs text-gray-400 space-y-1">
                {selected.list_name && <p>Lista: <b className="text-gray-600">{selected.list_name}</b></p>}
                {selected.scheduled_at && <p>Programado: {new Date(selected.scheduled_at).toLocaleString('es-AR')}</p>}
                {selected.completed_at && <p>Completado: {new Date(selected.completed_at).toLocaleString('es-AR')}</p>}
                <p>Antibloqueo: {selected.antiblock_delay_min}–{selected.antiblock_delay_max} seg entre mensajes</p>
                <p className="flex items-center gap-1">
                  {selected.personalize_name
                    ? <><UserCheck size={11} className="text-green-500"/> Nombre personalizado activado</>
                    : <><UserX size={11} className="text-gray-400"/> Nombre personalizado desactivado</>
                  }
                </p>
              </div>

              {/* Tabla de contactos */}
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">Destinatarios</p>
                {detailError
                  ? <p className="text-sm text-red-500 bg-red-50 border border-red-200 rounded px-3 py-2">{detailError}</p>
                  : loadingContacts
                  ? <div className="flex items-center gap-2 py-4 text-gray-400 text-sm"><Loader2 size={14} className="animate-spin"/> Cargando…</div>
                  : campContacts.length === 0
                    ? <p className="text-sm text-gray-400">Sin contactos registrados</p>
                    : (
                      <div className="border rounded-lg overflow-hidden">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50 border-b border-gray-100">
                            <tr>
                              <th className="text-left px-3 py-2 font-medium text-gray-600">Contacto</th>
                              <th className="text-left px-3 py-2 font-medium text-gray-600">Teléfono</th>
                              <th className="text-left px-3 py-2 font-medium text-gray-600">Estado</th>
                              <th className="text-left px-3 py-2 font-medium text-gray-600">Enviado</th>
                              <th className="text-left px-3 py-2 font-medium text-gray-600">Leído</th>
                            </tr>
                          </thead>
                          <tbody>
                            {campContacts.map(c => (
                              <tr key={c.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                                <td className="px-3 py-2">
                                  {[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}
                                </td>
                                <td className="px-3 py-2 font-mono text-xs text-gray-500">{c.phone_number}</td>
                                <td className="px-3 py-2">
                                  <ContactStatusBadge status={c.msg_status} />
                                </td>
                                <td className="px-3 py-2 text-xs text-gray-400">
                                  {c.sent_at ? new Date(c.sent_at).toLocaleString('es-AR', { dateStyle:'short', timeStyle:'short' }) : '—'}
                                </td>
                                <td className="px-3 py-2 text-xs text-gray-400">
                                  {c.read_at ? new Date(c.read_at).toLocaleString('es-AR', { dateStyle:'short', timeStyle:'short' }) : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                }
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function MiniStat({ label, value, pct, color }: { label: string; value: number; pct?: number; color: string }) {
  const colors: Record<string, string> = { blue:'text-blue-600', green:'text-green-600', purple:'text-purple-600', red:'text-red-500' }
  return (
    <div>
      <p className={`text-lg font-bold ${colors[color]}`}>{value}{pct !== undefined ? <span className="text-xs font-normal ml-0.5">{pct}%</span> : ''}</p>
      <p className="text-xs text-gray-400">{label}</p>
    </div>
  )
}

function StatBox({ label, value, color, pct }: { label: string; value: number; color: string; pct?: number }) {
  const colors: Record<string, string> = { blue:'text-blue-600 bg-blue-50', green:'text-green-600 bg-green-50', purple:'text-purple-600 bg-purple-50', red:'text-red-500 bg-red-50' }
  return (
    <div className={`rounded-lg p-3 ${colors[color]}`}>
      <p className="text-xl font-bold">{value}</p>
      {pct !== undefined && <p className="text-xs">{pct}%</p>}
      <p className="text-xs opacity-70">{label}</p>
    </div>
  )
}

function ProgressBar({ label, value, color }: { label: string; value: number; color: string }) {
  const colors: Record<string, string> = { green: 'bg-green-500', purple: 'bg-purple-500' }
  return (
    <div>
      <div className="flex justify-between text-xs text-gray-500 mb-1"><span>{label}</span><span>{value}%</span></div>
      <div className="w-full bg-gray-100 rounded-full h-2">
        <div className={`${colors[color]} h-2 rounded-full transition-all`} style={{ width: `${Math.min(value,100)}%` }} />
      </div>
    </div>
  )
}

function ContactStatusBadge({ status }: { status: string | null }) {
  if (!status) return (
    <span className="flex items-center gap-1 text-xs text-gray-400">
      <HelpCircle size={12}/> Sin enviar
    </span>
  )
  const map: Record<string, { label: string; className: string; icon: React.ReactNode }> = {
    read:      { label: 'Leído',      className: 'text-purple-600', icon: <CheckCheck size={12}/> },
    delivered: { label: 'Entregado',  className: 'text-green-600',  icon: <Truck size={12}/> },
    sent:      { label: 'Enviado',    className: 'text-blue-500',   icon: <Send size={12}/> },
    failed:    { label: 'Fallido',    className: 'text-red-500',    icon: <AlertTriangle size={12}/> },
  }
  const s = map[status] || { label: status, className: 'text-gray-500', icon: <HelpCircle size={12}/> }
  return (
    <span className={`flex items-center gap-1 text-xs font-medium ${s.className}`}>
      {s.icon} {s.label}
    </span>
  )
}
