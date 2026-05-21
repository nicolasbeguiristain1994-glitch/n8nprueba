'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Send, Plus, Loader2, Eye, Play, BarChart2, Shield, Clock, Pause, XCircle, CheckCheck, Truck, AlertTriangle, HelpCircle, Trash2, Shuffle, UserCheck, UserX, Zap, GitBranch, RefreshCw, Ban, ImageIcon, X, Upload, ListPlus } from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'
import { useCurrentUser } from '@/lib/useCurrentUser'

interface CampaignList { id: string; name: string; contact_count: number }
interface ProspectListOption { id: string; name: string; member_count: number }
interface AntiBanProfile { id: string; profile_name: string; is_default: boolean; timing_mode: string; risk_tolerance: string; recommended_for: string | null }
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
  total_read: number; total_failed: number; total_skipped: number
  read_rate: number; delivery_rate: number
  list_name: string | null; list_id: string | null
  prospect_list_id: string | null; prospect_list_name: string | null
  antiblock_delay_min: number; antiblock_delay_max: number
  personalize_name: boolean; use_multi_line: boolean; created_at: string
  pause_reason: 'manual' | 'no_eligible_lines' | 'all_lines_outside_schedule' | 'systemic_error' | 'config_missing' | 'frequency_exhausted' | 'unknown' | null
  processor_locked_at: string | null
}
interface DispatchSummary {
  total: number; queued: number; processing: number
  sent: number; failed: number; skipped: number
  eligible_lines: number
  line_usage: { line_id: string; line_key: string; display_name: string; sent: number; failed: number }[]
  top_errors?: { error: string; count: number }[]
}

const STATUS_BADGE: Record<string, string> = {
  draft:      'bg-gray-100 text-gray-600',
  scheduled:  'bg-blue-100 text-blue-700',
  running:    'bg-yellow-100 text-yellow-700',
  completed:  'bg-green-100 text-green-700',
  paused:     'bg-orange-100 text-orange-700',
  cancelled:  'bg-red-100 text-red-600',
}

const STATUS_LABEL: Record<string, string> = {
  draft:     'Borrador',
  scheduled: 'Programado',
  running:   'Enviando',
  completed: 'Completado',
  paused:    'Pausado',
  cancelled: 'Cancelado',
}

export default function Campaigns() {
  const { user } = useCurrentUser()
  const isAdmin  = user?.role === 'admin'

  const [campaigns, setCampaigns]         = useState<Campaign[]>([])
  const [lists, setLists]                 = useState<CampaignList[]>([])
  const [prospectLists, setProspectLists] = useState<ProspectListOption[]>([])
  const [antiBanProfiles, setAntiBanProfiles] = useState<AntiBanProfile[]>([])
  const [showNew, setShowNew]             = useState(false)
  const [selected, setSelected]       = useState<Campaign | null>(null)
  const [campContacts, setCampContacts] = useState<CampaignContact[]>([])
  const [loadingContacts, setLoadingContacts] = useState(false)
  const [sending, setSending]         = useState<string | null>(null)
  const [sendError, setSendError]     = useState<string | null>(null)
  const [actioning, setActioning]     = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [dispatch, setDispatch]       = useState<DispatchSummary | null>(null)
  const [loadingDispatch, setLoadingDispatch] = useState(false)
  const [resuming, setResuming]               = useState<string | null>(null)
  const [freqResetting, setFreqResetting]     = useState<string | null>(null)
  const [retryingFailed, setRetryingFailed]   = useState<string | null>(null)
  const [unlocking, setUnlocking]         = useState<string | null>(null)
  const [syncing, setSyncing]             = useState<string | null>(null)
  const [creatingFailedList, setCreatingFailedList] = useState(false)
  const [failedListMsg, setFailedListMsg]           = useState<string | null>(null)

  const FORM_DEFAULT = {
    name: '', list_id: '', prospect_list_id: '', audience_type: 'contacts' as 'contacts' | 'prospects',
    scheduled_at: '',
    media_url: '', antiblock_delay_min: 3, antiblock_delay_max: 8,
    type: 'promotion', personalize_name: true, use_multi_line: false,
    delay_type: 'gaussian', custom_delay_seconds: 18,
    daily_limit_override: '' as '' | number,
    anti_ban_profile_id: '',
    enable_mini_sessions: false, mini_session_text: '👍',
  }

  // Form
  const [form, setForm] = useState(FORM_DEFAULT)
  const [messages, setMessages] = useState<string[]>([''])
  const [previewIdx, setPreviewIdx] = useState(0)
  const [creating, setCreating] = useState(false)

  // Upload de imagen
  const [uploadingMedia, setUploadingMedia] = useState(false)
  const [uploadError, setUploadError]       = useState<string | null>(null)
  const mediaInputRef = useRef<HTMLInputElement>(null)

  const uploadMedia = async (file: File) => {
    setUploadingMedia(true); setUploadError(null)
    const fd = new FormData()
    fd.append('file', file)
    try {
      const res  = await fetch('/api/upload', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) { setUploadError(data.error || 'Error al subir imagen'); return }
      setForm(f => ({ ...f, media_url: data.url }))
    } catch {
      setUploadError('Error de red al subir imagen')
    } finally {
      setUploadingMedia(false)
    }
  }

  // Plantillas
  const [useTemplate,      setUseTemplate]      = useState(false)
  const [templateList,     setTemplateList]     = useState<{ id: string; name: string; components: unknown[] }[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState<string>('')

  // Cargar plantillas aprobadas cuando se abre el modal
  const loadTemplates = useCallback(() => {
    fetchJson<{ templates: { id: string; name: string; components: unknown[] }[] }>('/api/templates?status=APROBADA')
      .then(d => setTemplateList(d.templates || []))
      .catch(() => setTemplateList([]))
  }, [])

  const load = useCallback(() => {
    fetchJson<{ campaigns: Campaign[] }>('/api/campaigns')
      .then(d => setCampaigns(d.campaigns || []))
      .catch(() => setCampaigns([]))
    fetchJson<{ lists: CampaignList[] }>('/api/lists')
      .then(d => setLists(d.lists || []))
      .catch(() => setLists([]))
    fetchJson<{ lists: ProspectListOption[] }>('/api/prospect-lists?limit=100')
      .then(d => setProspectLists(d.lists || []))
      .catch(() => setProspectLists([]))
    fetchJson<{ profiles: AntiBanProfile[] }>('/api/anti-ban-profiles')
      .then(d => setAntiBanProfiles(d.profiles || []))
      .catch(() => setAntiBanProfiles([]))
  }, [])

  useEffect(() => { load() }, [load])

  const createCampaign = async () => {
    setCreating(true)
    setCreateError(null)
    const validMsgs = messages.filter(m => m.trim())
    if (form.daily_limit_override !== '' && Number(form.daily_limit_override) < 5) {
      setCreating(false)
      setCreateError('El límite diario por línea debe ser al menos 5')
      return
    }
    let res: Response
    try {
      const payload: Record<string, unknown> = {
        ...form,
        messages: validMsgs,
        message: validMsgs[0],
        daily_limit_override: form.daily_limit_override === '' ? null : Number(form.daily_limit_override),
        anti_ban_profile_id: form.anti_ban_profile_id === '' ? null : form.anti_ban_profile_id,
        // Audiencia: solo uno de los dos debe ir en el payload
        list_id:          form.audience_type === 'contacts'  ? (form.list_id          || null) : null,
        prospect_list_id: form.audience_type === 'prospects' ? (form.prospect_list_id || null) : null,
      }
      if (useTemplate && selectedTemplate) {
        payload.template_id = selectedTemplate
      }
      res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
    setForm(FORM_DEFAULT)
    setMessages([''])
    setPreviewIdx(0)
    load()
  }

  const onSelectTemplate = (tplId: string | null) => {
    if (!tplId) return
    setSelectedTemplate(tplId)
    const tpl = templateList.find(t => t.id === tplId)
    if (!tpl) return
    const bodyComp = (tpl.components as Array<{ type: string; text?: string }>).find(c => c.type === 'BODY')
    if (bodyComp?.text) {
      setMessages([bodyComp.text])
      setPreviewIdx(0)
    }
  }

  const addMessage    = () => { if (messages.length < 10) setMessages(m => [...m, '']) }
  const removeMessage = (i: number) => setMessages(m => m.filter((_, idx) => idx !== i))
  const updateMessage = (i: number, val: string) => setMessages(m => m.map((v, idx) => idx === i ? val : v))

  const sendNow = async (campaign: Campaign) => {
    setSending(campaign.id)
    setSendError(null)
    try {
      // Multi-line campaigns use the distributor endpoint; single-line use n8n send
      const endpoint = campaign.use_multi_line
        ? `/api/campaigns/${campaign.id}/dispatch`
        : `/api/campaigns/${campaign.id}/send`
      const res = await fetch(endpoint, { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        // 409 = campaign auto-completed (all contacts already processed) — just refresh
        if (res.status === 409) {
          load()
        } else {
          setSendError(d.error || `Error ${res.status}`)
        }
      } else {
        setTimeout(load, 1000)
      }
    } catch {
      setSendError('Error de red al enviar')
    } finally {
      setSending(null)
    }
  }

  const resetFreq = async (campaign: Campaign) => {
    if (!confirm(`¿Resetear campaña "${campaign.name}" para re-prueba?\n\nEsto va a:\n• Borrar el historial de frecuencia (levanta el bloqueo de 48h)\n• Volver TODOS los contactos a "pendiente" (incluso los ya enviados)\n• Resetear contadores de la campaña\n\nUsar solo en entornos de prueba.`)) return
    setFreqResetting(campaign.id)
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/freq-reset`, { method: 'DELETE' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setSendError(d.error || 'Error al resetear campaña')
      } else {
        setSendError(null)
        // Cerrar el modal si está abierto y recargar la lista
        if (selected?.id === campaign.id) setSelected(null)
        load()
      }
    } catch {
      setSendError('Error de red al limpiar frecuencia')
    } finally {
      setFreqResetting(null)
    }
  }

  const retryFailed = async (campaign: Campaign) => {
    if (!confirm(`¿Reintentar los ${campaign.total_failed} contactos fallidos de "${campaign.name}"?\n\nLos ${campaign.total_sent} ya enviados NO se re-enviarán.`)) return
    setRetryingFailed(campaign.id)
    setSendError(null)
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/retry-failed`, { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setSendError(d.error || 'Error al preparar reintento')
      } else {
        setSendError(null)
        load()
        // Reanudar el procesador automáticamente
        await resumeProcessor(campaign.id)
      }
    } catch {
      setSendError('Error de red')
    } finally {
      setRetryingFailed(null)
    }
  }

  const createListFromFailed = async (campaign: Campaign) => {
    const failed = campContacts.filter(c => c.msg_status === 'failed')
    if (failed.length === 0) return
    setCreatingFailedList(true)
    setFailedListMsg(null)
    try {
      const name = `Fallidos – ${campaign.name} (${new Date().toLocaleDateString('es-AR')})`
      const res = await fetch('/api/lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, contact_ids: failed.map(c => c.id) }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setFailedListMsg(`Error: ${d.error || 'No se pudo crear la lista'}`)
      } else {
        setFailedListMsg(`Lista "${name}" creada con ${failed.length} contacto${failed.length !== 1 ? 's' : ''}.`)
        load()
      }
    } catch {
      setFailedListMsg('Error de red al crear la lista')
    } finally {
      setCreatingFailedList(false)
    }
  }

  const resumeProcessor = async (id: string) => {
    setResuming(id)
    setSendError(null)
    try {
      // For multi-line paused campaigns, first try dispatch (seeds + starts processor)
      const res = await fetch(`/api/campaigns/${id}/dispatch`, { method: 'POST' })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        if (res.status === 409) {
          // All contacts already processed → campaign auto-completed → just refresh
          load()
        } else {
          setSendError(d.error || `Error al reanudar`)
        }
      } else {
        setTimeout(load, 1500)
      }
    } catch {
      setSendError('Error de red al reanudar')
    } finally {
      setResuming(null)
    }
  }

  const forceUnlock = async (campaign: Campaign) => {
    if (!confirm(`¿Liberar el lock de "${campaign.name}"?\n\nEsto pausará la campaña y liberará el procesador bloqueado. Luego podés reanudarla manualmente.`)) return
    setUnlocking(campaign.id)
    setSendError(null)
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/force-unlock`, { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setSendError(d.error || 'Error al liberar el lock')
      } else {
        load()
      }
    } catch {
      setSendError('Error de red al liberar el lock')
    } finally {
      setUnlocking(null)
    }
  }

  const syncStatus = async (campaign: Campaign) => {
    setSyncing(campaign.id)
    try {
      await fetch(`/api/campaigns/${campaign.id}/sync-status`, { method: 'POST' })
      load()
    } catch { /* best effort */ } finally {
      setSyncing(null)
    }
  }

  const openDetail = async (c: Campaign) => {
    setSelected(c)
    setCampContacts([])
    setDetailError(null)
    setDispatch(null)
    setFailedListMsg(null)
    setLoadingContacts(true)

    // Fetch contacts and (for multi-line) dispatch summary in parallel
    const contactsFetch = fetch(`/api/campaigns/${c.id}/contacts`)
      .then(r => r.json())
      .then(d => setCampContacts(d.contacts || []))
      .catch(() => setDetailError('Error de red al cargar destinatarios'))
      .finally(() => setLoadingContacts(false))

    const dispatchFetch = c.use_multi_line
      ? (setLoadingDispatch(true),
         fetch(`/api/campaigns/${c.id}/dispatch`)
           .then(r => r.json())
           .then(d => setDispatch(d))
           .catch(() => null)
           .finally(() => setLoadingDispatch(false)))
      : Promise.resolve()

    await Promise.all([contactsFetch, dispatchFetch])
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
                          {STATUS_LABEL[c.status] ?? c.status}
                        </span>
                        {c.use_multi_line && (
                          <span className="text-xs bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded-full flex items-center gap-1">
                            <GitBranch size={10}/> multi-línea
                          </span>
                        )}
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
                        {(c.list_name || c.prospect_list_name) && (
                          <span>Lista: <b className="text-gray-600">{c.list_name || c.prospect_list_name}</b></span>
                        )}
                        <span>{c.total_targets} dest.</span>
                        <span className="flex items-center gap-1"><Shield size={10}/> {c.antiblock_delay_min}-{c.antiblock_delay_max}s</span>
                        {c.personalize_name
                          ? <span className="flex items-center gap-1 text-green-600"><UserCheck size={10}/> con nombre</span>
                          : <span className="flex items-center gap-1 text-gray-400"><UserX size={10}/> sin nombre</span>
                        }
                      </div>
                    </div>

                    {/* Métricas inline */}
                    {(c.total_sent > 0 || c.total_skipped > 0 || c.total_failed > 0) && (
                      <div className="flex gap-4 text-center shrink-0">
                        <MiniStat label="Enviados"   value={c.total_sent}      color="blue" />
                        <MiniStat label="Entregados" value={c.total_delivered} color="green" />
                        <MiniStat label="Leídos"     value={c.total_read}      pct={c.read_rate} color="purple" />
                        {c.total_failed  > 0 && <MiniStat label="Fallidos"       value={c.total_failed}  color="red" />}
                        {c.total_skipped > 0 && <MiniStat label="Omitidos (freq.)" value={c.total_skipped} color="orange" />}
                      </div>
                    )}

                    <div className="flex gap-2 shrink-0">
                      <Button variant="outline" size="sm" onClick={() => openDetail(c)}>
                        <Eye size={13} />
                      </Button>

                      {/* Enviar: draft, scheduled */}
                      {(c.status === 'draft' || c.status === 'scheduled') && (c.list_name || c.prospect_list_name) && (
                        <Button size="sm" className="bg-green-600 hover:bg-green-700"
                                onClick={() => sendNow(c)} disabled={sending === c.id}>
                          {sending === c.id
                            ? <Loader2 size={13} className="animate-spin"/>
                            : <><Play size={13} className="mr-1"/>Enviar</>}
                        </Button>
                      )}

                      {/* Reanudar: paused */}
                      {c.status === 'paused' && (c.list_name || c.prospect_list_name) && (
                        <Button size="sm" className="bg-green-600 hover:bg-green-700"
                                onClick={() => c.use_multi_line ? resumeProcessor(c.id) : sendNow(c)}
                                disabled={sending === c.id || resuming === c.id}>
                          {(sending === c.id || resuming === c.id)
                            ? <Loader2 size={13} className="animate-spin"/>
                            : <><Play size={13} className="mr-1"/>Reanudar</>}
                        </Button>
                      )}

                      {/* Verificar / completar: running con todos los contactos ya enviados */}
                      {c.status === 'running' && c.total_sent > 0 && c.use_multi_line && (
                        <Button size="sm" className="bg-green-600 hover:bg-green-700"
                                onClick={() => resumeProcessor(c.id)}
                                disabled={resuming === c.id}>
                          {resuming === c.id
                            ? <Loader2 size={13} className="animate-spin"/>
                            : <><CheckCheck size={13} className="mr-1"/>Verificar</>}
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

                      {/* Sync estados entregado/leído desde Evolution */}
                      {['completed','running'].includes(c.status) && c.total_sent > 0 && (
                        <Button size="sm" variant="outline"
                                className="border-blue-200 text-blue-500 hover:bg-blue-50"
                                title="Sincronizar estados de entrega y lectura"
                                onClick={() => syncStatus(c)}
                                disabled={syncing === c.id}>
                          {syncing === c.id
                            ? <Loader2 size={13} className="animate-spin"/>
                            : <Truck size={13} />}
                        </Button>
                      )}

                      {/* Reintentar solo fallidos — sin re-enviar a los ya enviados */}
                      {['completed','paused','cancelled','running'].includes(c.status) && c.total_failed > 0 && (
                        <Button size="sm" variant="outline"
                                className="border-red-200 text-red-600 hover:bg-red-50"
                                title={`Reintentar ${c.total_failed} fallidos (sin re-enviar a los ${c.total_sent} ya enviados)`}
                                onClick={() => retryFailed(c)}
                                disabled={retryingFailed === c.id || resuming === c.id}>
                          {retryingFailed === c.id
                            ? <Loader2 size={13} className="animate-spin"/>
                            : <span className="text-xs font-bold">↺F</span>}
                        </Button>
                      )}

                      {/* Reset completo para re-prueba — en campañas ya procesadas */}
                      {['completed','paused','cancelled','running'].includes(c.status) && (c.total_sent > 0 || c.total_skipped > 0 || c.total_failed > 0) && (
                        <Button size="sm" variant="outline"
                                className="border-orange-200 text-orange-500 hover:bg-orange-50"
                                title="Resetear para re-prueba (admin)"
                                onClick={() => resetFreq(c)}
                                disabled={freqResetting === c.id}>
                          {freqResetting === c.id
                            ? <Loader2 size={13} className="animate-spin"/>
                            : <RefreshCw size={13} />}
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Aviso de pausa */}
                  {c.status === 'paused' && (
                    <div className="mt-2 flex items-start gap-1.5 text-xs text-orange-600">
                      <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                      <span>
                        {c.pause_reason === 'manual' && (
                          <>Pausado manualmente. <span className="text-gray-500">Presioná Reanudar para continuar.</span></>
                        )}
                        {c.pause_reason === 'no_eligible_lines' && (() => {
                          const pending = c.total_targets - c.total_sent - c.total_failed - c.total_skipped
                          return <>{pending} destinatarios pendientes — sin líneas activas o con cuota agotada. <span className="text-gray-500">Reconectá líneas o esperá que se reinicien los contadores, luego reanudar.</span></>
                        })()}
                        {c.pause_reason === 'all_lines_outside_schedule' && (() => {
                          const pending = c.total_targets - c.total_sent - c.total_failed - c.total_skipped
                          return <>{pending} destinatarios pendientes — todas las líneas fuera de su ventana de horario. <span className="text-gray-500">Se retomarán automáticamente al reanudar cuando las líneas entren en horario.</span></>
                        })()}
                        {c.pause_reason === 'systemic_error' && (() => {
                          const pending = c.total_targets - c.total_sent - c.total_failed - c.total_skipped
                          return <>{pending} destinatarios pendientes — error sistémico del procesador. <span className="text-gray-500">Revisá los logs antes de reanudar. Si el problema persiste, contactá soporte.</span></>
                        })()}
                        {c.pause_reason === 'config_missing' && (
                          <>Configuración incompleta: falta <code className="bg-orange-100 px-0.5 rounded">EVOLUTION_API_KEY</code> o <code className="bg-orange-100 px-0.5 rounded">EVOLUTION_GLOBAL_API_KEY</code>. <span className="text-gray-500">Configurar la variable de entorno y reanudar.</span></>
                        )}
                        {c.pause_reason === 'frequency_exhausted' && (
                          <>Todos los contactos bloqueados por límite de frecuencia. <span className="text-gray-500">Los contactos podrán recibir mensajes en la siguiente ventana (24h/7d).</span></>
                        )}
                        {(c.pause_reason === 'unknown' || !c.pause_reason) && (() => {
                          const pending = c.total_targets - c.total_sent - c.total_failed - c.total_skipped
                          return pending > 0
                            ? <>{pending} destinatarios pendientes — pausado automáticamente. <span className="text-gray-500">Reanudar para continuar.</span></>
                            : <>Pausado.</>
                        })()}
                      </span>
                    </div>
                  )}

                  {/* Force-unlock para admin: campaña en running con lock activo */}
                  {isAdmin && c.status === 'running' && c.processor_locked_at && (() => {
                    const lockedMs = Date.now() - new Date(c.processor_locked_at).getTime()
                    const lockedMin = Math.floor(lockedMs / 60_000)
                    if (lockedMin < 20) return null  // lock reciente, no mostramos
                    return (
                      <div className="mt-2 flex items-center gap-2 text-xs text-red-500">
                        <AlertTriangle size={11} className="shrink-0" />
                        <span>Procesador bloqueado hace {lockedMin} min sin progreso evidente.</span>
                        <button
                          className="underline hover:text-red-700 disabled:opacity-50 whitespace-nowrap"
                          disabled={unlocking === c.id}
                          onClick={() => forceUnlock(c)}
                        >
                          {unlocking === c.id ? <Loader2 size={11} className="inline animate-spin"/> : 'Liberar lock (admin)'}
                        </button>
                      </div>
                    )
                  })()}

                  {/* Aviso de campaign all-skipped completada */}
                  {c.status === 'completed' && c.total_skipped > 0 &&
                   c.total_sent === 0 && c.total_failed === 0 && (
                    <div className="mt-2 flex items-center gap-1.5 text-xs text-orange-500">
                      <Ban size={11} />
                      <span>Todos los contactos omitidos por límite de frecuencia</span>
                    </div>
                  )}

                  {/* Barra de progreso */}
                  {c.status === 'running' && c.total_targets > 0 && (
                    <div className="mt-3">
                      <div className="flex justify-between text-xs text-gray-400 mb-1">
                        <span>Enviando…</span>
                        <span>{c.total_sent + c.total_failed + c.total_skipped}/{c.total_targets}</span>
                      </div>
                      <div className="w-full bg-gray-100 rounded-full h-1.5">
                        <div className="bg-green-500 h-1.5 rounded-full transition-all"
                             style={{ width: `${((c.total_sent + c.total_failed + c.total_skipped)/c.total_targets)*100}%` }} />
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
          setForm(FORM_DEFAULT)
          setMessages([''])
          setPreviewIdx(0)
          setCreating(false)
          setCreateError(null)
          setSendError(null)
          setUseTemplate(false)
          setSelectedTemplate('')
          setUploadError(null)
        }
      }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Nueva campaña</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            {/* Nombre de campaña */}
            <div className="col-span-2">
              <label className="text-xs font-medium text-gray-600 mb-1 block">Nombre de campaña</label>
              <Input
                placeholder="Ej: Retención VIP Mayo, Promo Slots Junio…"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>

            {/* Toggle plantilla */}
            <div className="col-span-2">
              <button
                type="button"
                onClick={() => {
                  const next = !useTemplate
                  setUseTemplate(next)
                  if (next) { loadTemplates(); setSelectedTemplate('') }
                  else { setSelectedTemplate('') }
                }}
                className={`flex items-center gap-3 w-full rounded-lg border px-4 py-3 text-sm transition-colors ${
                  useTemplate
                    ? 'border-green-200 bg-green-50 text-green-800'
                    : 'border-gray-200 bg-gray-50 text-gray-500'
                }`}
              >
                <div className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${useTemplate ? 'bg-green-500' : 'bg-gray-300'}`}>
                  <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${useTemplate ? 'translate-x-4' : ''}`} />
                </div>
                {useTemplate ? 'Usar plantilla aprobada activado' : 'Usar plantilla aprobada (opcional)'}
              </button>
              {useTemplate && (
                <div className="mt-2">
                  <Select value={selectedTemplate} onValueChange={onSelectTemplate}>
                    <SelectTrigger className="text-sm"><SelectValue placeholder="Seleccionar plantilla…" /></SelectTrigger>
                    <SelectContent>
                      {templateList.length === 0
                        ? <SelectItem value="_none" disabled>No hay plantillas aprobadas</SelectItem>
                        : templateList.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)
                      }
                    </SelectContent>
                  </Select>
                  {selectedTemplate && <p className="text-xs text-green-600 mt-1">Mensaje cargado desde la plantilla seleccionada.</p>}
                </div>
              )}
            </div>

            <div className="col-span-2">
              <label className="text-xs font-medium text-gray-600 mb-1 block">Tipo de campaña</label>
              <Select value={form.type} onValueChange={v => setForm(f => ({ ...f, type: v ?? 'promotion' }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Seleccioná el tipo de campaña" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="promotion">Promoción</SelectItem>
                  <SelectItem value="retention">Retención</SelectItem>
                  <SelectItem value="onboarding">Onboarding</SelectItem>
                  <SelectItem value="support">Soporte</SelectItem>
                  <SelectItem value="survey">Encuesta</SelectItem>
                  <SelectItem value="payment">Pago</SelectItem>
                  <SelectItem value="risk_alert">Alerta de riesgo</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Tipo de audiencia</label>
              <div className="flex gap-2 mb-2">
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, audience_type: 'contacts', prospect_list_id: '' }))}
                  className={`flex-1 py-1.5 text-xs rounded-md border transition-colors font-medium ${
                    form.audience_type === 'contacts'
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 text-gray-500 hover:border-gray-300'
                  }`}
                >
                  Contactos
                </button>
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, audience_type: 'prospects', list_id: '' }))}
                  className={`flex-1 py-1.5 text-xs rounded-md border transition-colors font-medium ${
                    form.audience_type === 'prospects'
                      ? 'border-violet-500 bg-violet-50 text-violet-700'
                      : 'border-gray-200 text-gray-500 hover:border-gray-300'
                  }`}
                >
                  Listas de Difusión
                </button>
              </div>
              {form.audience_type === 'contacts' ? (
                <>
                  <Select value={form.list_id} onValueChange={v => setForm(f=>({...f,list_id:v ?? ''}))}>
                    <SelectTrigger><SelectValue placeholder="Seleccioná una lista de contactos" /></SelectTrigger>
                    <SelectContent>
                      {lists.map(l => <SelectItem key={l.id} value={l.id}>{l.name} ({l.contact_count} contactos)</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {lists.length === 0 && <p className="text-xs text-orange-500 mt-1">Creá primero una lista en Contactos</p>}
                </>
              ) : (
                <>
                  <Select value={form.prospect_list_id} onValueChange={v => setForm(f=>({...f,prospect_list_id:v ?? ''}))}>
                    <SelectTrigger><SelectValue placeholder="Seleccioná una lista de difusión" /></SelectTrigger>
                    <SelectContent>
                      {prospectLists.map(l => <SelectItem key={l.id} value={l.id}>{l.name} ({l.member_count.toLocaleString()} prospectos)</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {prospectLists.length === 0 && <p className="text-xs text-orange-500 mt-1">Creá primero una lista en Contactos › Listas de Difusión</p>}
                </>
              )}
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

            {/* Modo multi-línea */}
            <div className="col-span-2">
              <button
                type="button"
                onClick={() => setForm(f => ({ ...f, use_multi_line: !f.use_multi_line }))}
                className={`flex items-center gap-3 w-full rounded-lg border px-4 py-3 text-sm transition-colors ${
                  form.use_multi_line
                    ? 'border-indigo-200 bg-indigo-50 text-indigo-800'
                    : 'border-gray-200 bg-gray-50 text-gray-500'
                }`}
              >
                <div className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${form.use_multi_line ? 'bg-indigo-500' : 'bg-gray-300'}`}>
                  <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${form.use_multi_line ? 'translate-x-4' : ''}`} />
                </div>
                <GitBranch size={15} className="shrink-0" />
                {form.use_multi_line
                  ? <span>Modo multi-línea activado — distribuye envíos entre todas las líneas elegibles</span>
                  : <span>Modo multi-línea desactivado — usa el flujo estándar de n8n (una línea)</span>
                }
              </button>
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

            {/* Imagen adjunta */}
            <div className="col-span-2">
              <label className="text-xs font-medium text-gray-600 mb-2 block flex items-center gap-1">
                <ImageIcon size={12} /> Imagen adjunta (opcional)
              </label>

              {form.media_url ? (
                <div className="relative w-full rounded-lg border border-gray-200 overflow-hidden bg-gray-50 flex items-center gap-3 p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={form.media_url}
                    alt="Media preview"
                    className="h-20 w-20 object-cover rounded-md border border-gray-200 shrink-0"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-500 truncate">{form.media_url}</p>
                    <p className="text-xs text-green-600 mt-0.5">Imagen cargada correctamente</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setForm(f => ({ ...f, media_url: '' })); setUploadError(null) }}
                    className="p-1 rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0"
                    title="Quitar imagen"
                  >
                    <X size={16} />
                  </button>
                </div>
              ) : (
                <div>
                  <input
                    ref={mediaInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    className="hidden"
                    onChange={e => {
                      const file = e.target.files?.[0]
                      if (file) uploadMedia(file)
                      e.target.value = ''
                    }}
                  />
                  <button
                    type="button"
                    disabled={uploadingMedia}
                    onClick={() => mediaInputRef.current?.click()}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => {
                      e.preventDefault()
                      const file = e.dataTransfer.files?.[0]
                      if (file) uploadMedia(file)
                    }}
                    className="w-full border-2 border-dashed border-gray-200 rounded-lg py-6 text-sm text-gray-400 hover:border-indigo-300 hover:text-indigo-500 transition-colors flex flex-col items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {uploadingMedia
                      ? <><Loader2 size={20} className="animate-spin text-indigo-400" /><span>Subiendo imagen…</span></>
                      : <><Upload size={20} /><span>Hacé clic o arrastrá una imagen aquí</span><span className="text-xs text-gray-300">JPG, PNG, WEBP, GIF · máx. 10 MB</span></>
                    }
                  </button>
                  {/* También permitir pegar URL directamente */}
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-px flex-1 bg-gray-100" />
                    <span className="text-xs text-gray-300">o pegá una URL</span>
                    <div className="h-px flex-1 bg-gray-100" />
                  </div>
                  <Input
                    className="mt-2"
                    placeholder="https://…"
                    value={form.media_url}
                    onChange={e => { setForm(f => ({ ...f, media_url: e.target.value })); setUploadError(null) }}
                  />
                </div>
              )}

              {uploadError && (
                <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
                  <AlertTriangle size={11} /> {uploadError}
                </p>
              )}
            </div>

            {/* Configuración Anti-Ban */}
            <div className="col-span-2 border border-indigo-100 rounded-xl p-4 space-y-4 bg-indigo-50/30">
              <div className="flex items-center gap-2">
                <Shield size={14} className="text-indigo-500" />
                <span className="text-sm font-semibold text-gray-700">Configuración Anti-Ban</span>
              </div>

              {/* Perfil Anti-Ban */}
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Perfil Anti-Ban</label>
                <Select value={form.anti_ban_profile_id} onValueChange={v => setForm(f => ({ ...f, anti_ban_profile_id: (!v || v === '_default') ? '' : v }))}>
                  <SelectTrigger className="text-sm bg-white">
                    <SelectValue placeholder="Usar perfil por defecto (Meta-Stealth-2026)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_default">Usar perfil por defecto</SelectItem>
                    {antiBanProfiles.map(p => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.profile_name}{p.is_default ? ' ★' : ''} — {p.risk_tolerance}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {antiBanProfiles.length === 0 && (
                  <p className="text-xs text-orange-500 mt-1">No se pudieron cargar los perfiles. Aplicá la migración 071 si aún no lo hiciste.</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Tipo de delay */}
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Tipo de Delay</label>
                  <Select value={form.delay_type} onValueChange={v => setForm(f => ({ ...f, delay_type: v ?? f.delay_type }))}>
                    <SelectTrigger className="text-sm bg-white"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="gaussian">Gaussiano (recomendado)</SelectItem>
                      <SelectItem value="human_noisy">Humano con ruido</SelectItem>
                      <SelectItem value="uniform">Uniforme</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Delay base */}
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Delay base (seg)</label>
                  <Input
                    type="number"
                    min={5}
                    max={120}
                    className="bg-white"
                    value={form.custom_delay_seconds}
                    onChange={e => setForm(f => ({ ...f, custom_delay_seconds: Number(e.target.value) }))}
                  />
                </div>
              </div>

              {/* Límite diario por línea */}
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Límite diario por línea (opcional)</label>
                <Input
                  type="number"
                  min={5}
                  placeholder="Sin límite adicional"
                  className="bg-white"
                  value={form.daily_limit_override}
                  onChange={e => setForm(f => ({ ...f, daily_limit_override: e.target.value === '' ? '' : Number(e.target.value) }))}
                />
                <p className="text-xs text-gray-400 mt-1">
                  Este límite se aplica solo a esta campaña. El perfil define el comportamiento general.
                </p>
              </div>

              {/* Mini-sessions */}
              <div>
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, enable_mini_sessions: !f.enable_mini_sessions }))}
                  className={`flex items-center gap-3 w-full rounded-lg border px-4 py-3 text-sm transition-colors ${
                    form.enable_mini_sessions
                      ? 'border-purple-200 bg-purple-50 text-purple-800'
                      : 'border-gray-200 bg-white text-gray-500'
                  }`}
                >
                  <div className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${form.enable_mini_sessions ? 'bg-purple-500' : 'bg-gray-300'}`}>
                    <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${form.enable_mini_sessions ? 'translate-x-4' : ''}`} />
                  </div>
                  <Zap size={15} className="shrink-0" />
                  {form.enable_mini_sessions
                    ? <span>Mini-sesión activada — envía seguimiento corto tras cada mensaje exitoso</span>
                    : <span>Mini-sesión desactivada</span>
                  }
                </button>
                {form.enable_mini_sessions && (
                  <div className="mt-2">
                    <label className="text-xs font-medium text-gray-600 mb-1 block">Texto de seguimiento</label>
                    <Input
                      placeholder="👍"
                      className="bg-white"
                      value={form.mini_session_text}
                      maxLength={100}
                      onChange={e => setForm(f => ({ ...f, mini_session_text: e.target.value }))}
                    />
                    <p className="text-xs text-gray-400 mt-1">Emoji o frase corta enviada tras el mensaje principal.</p>
                  </div>
                )}
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
                {STATUS_LABEL[selected?.status ?? ''] ?? selected?.status}
              </span>
            </DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4">
              {/* Métricas */}
              <div className={`grid gap-3 text-center ${selected.total_skipped > 0 ? 'grid-cols-5' : 'grid-cols-4'}`}>
                <StatBox label="Enviados"    value={selected.total_sent}      color="blue"   />
                <StatBox label="Entregados"  value={selected.total_delivered} color="green"  />
                <StatBox label="Leídos"      value={selected.total_read}      color="purple" pct={selected.read_rate} />
                <StatBox label="Fallidos"    value={selected.total_failed}    color="red"    />
                {selected.total_skipped > 0 && (
                  <StatBox label="Omitidos (freq.)" value={selected.total_skipped} color="orange" />
                )}
              </div>

              {selected.total_skipped > 0 && (
                <div className="flex items-start gap-2 text-xs text-orange-600 bg-orange-50 border border-orange-100 rounded-lg px-3 py-2">
                  <Ban size={12} className="shrink-0 mt-0.5" />
                  <span>
                    {selected.total_skipped} contacto{selected.total_skipped !== 1 ? 's' : ''} omitido{selected.total_skipped !== 1 ? 's' : ''} por
                    límite de frecuencia (máx. 1/día, 2/semana, cooldown 48h). Podrán recibir mensajes en la siguiente campaña o ventana de tiempo.
                  </span>
                </div>
              )}

              {selected.total_targets > 0 && (
                <div className="space-y-2">
                  <ProgressBar label="Tasa de entrega" value={selected.delivery_rate} color="green" />
                  <ProgressBar label="Tasa de lectura" value={selected.read_rate}     color="purple" />
                </div>
              )}

              {/* Detalle de fallos — visible inmediatamente si hay fallidos */}
              {selected.total_failed > 0 && (
                <div className="border border-red-200 rounded-lg p-3 bg-red-50 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-red-700 flex items-center gap-1.5">
                      <AlertTriangle size={14} /> {selected.total_failed} envío{selected.total_failed !== 1 ? 's' : ''} fallido{selected.total_failed !== 1 ? 's' : ''}
                    </p>
                    {!loadingContacts && campContacts.filter(c => c.msg_status === 'failed').length > 0 && (
                      <Button
                        size="sm" variant="outline"
                        className="border-red-300 text-red-600 hover:bg-red-100 text-xs h-7 px-2 shrink-0"
                        onClick={() => createListFromFailed(selected)}
                        disabled={creatingFailedList}
                        title="Crear una nueva lista de contactos con los fallidos para volver a difundirles"
                      >
                        {creatingFailedList
                          ? <Loader2 size={11} className="animate-spin mr-1" />
                          : <ListPlus size={11} className="mr-1" />
                        }
                        Crear lista
                      </Button>
                    )}
                  </div>
                  {loadingContacts
                    ? <p className="text-xs text-red-400 flex items-center gap-1"><Loader2 size={11} className="animate-spin"/> Cargando errores…</p>
                    : (() => {
                        const failed = campContacts.filter(c => c.msg_status === 'failed')
                        if (failed.length === 0) return <p className="text-xs text-red-400">Sin detalle disponible</p>
                        const grouped = failed.reduce<Record<string, number>>((acc, c) => {
                          const k = c.error_detail || 'sin detalle'
                          acc[k] = (acc[k] || 0) + 1
                          return acc
                        }, {})
                        return (
                          <div className="space-y-1.5">
                            {Object.entries(grouped).sort((a,b) => b[1]-a[1]).map(([err, cnt], i) => (
                              <div key={i} className="flex items-start gap-2 text-xs bg-white border border-red-100 rounded px-2 py-1.5">
                                <span className="shrink-0 font-bold text-red-500 min-w-[2rem]">{cnt}×</span>
                                <span className="font-mono text-red-700 break-all">{err}</span>
                              </div>
                            ))}
                            <p className="text-xs text-red-400 pt-1">Ver tabla de destinatarios abajo para detalle por contacto.</p>
                          </div>
                        )
                      })()
                  }
                  {failedListMsg && (
                    <p className={`text-xs pt-1 ${failedListMsg.startsWith('Error') ? 'text-red-600' : 'text-green-700 font-medium'}`}>
                      {failedListMsg}
                    </p>
                  )}
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
                {(selected.list_name || selected.prospect_list_name) && (
                  <p>Lista: <b className="text-gray-600">{selected.list_name || selected.prospect_list_name}</b></p>
                )}
                {selected.scheduled_at && <p>Programado: {new Date(selected.scheduled_at).toLocaleString('es-AR')}</p>}
                {selected.completed_at && <p>Completado: {new Date(selected.completed_at).toLocaleString('es-AR')}</p>}
                <p>Antibloqueo: {selected.antiblock_delay_min}–{selected.antiblock_delay_max} seg entre mensajes</p>
                <p className="flex items-center gap-1">
                  {selected.personalize_name
                    ? <><UserCheck size={11} className="text-green-500"/> Nombre personalizado activado</>
                    : <><UserX size={11} className="text-gray-400"/> Nombre personalizado desactivado</>
                  }
                </p>
                <p className="flex items-center gap-1">
                  {selected.use_multi_line
                    ? <><GitBranch size={11} className="text-indigo-500"/> Modo multi-línea</>
                    : <><Zap size={11} className="text-gray-400"/> Modo estándar (n8n)</>
                  }
                </p>
              </div>

              {/* Dispatch progress — multi-line only */}
              {selected.use_multi_line && (
                <div className="border rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
                      <GitBranch size={14} className="text-indigo-500" /> Progreso de distribución
                    </p>
                    <button
                      className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"
                      onClick={async () => {
                        setLoadingDispatch(true)
                        try {
                          const d = await fetchJson<DispatchSummary>(`/api/campaigns/${selected.id}/dispatch`)
                          setDispatch(d)
                        } catch { /* ignore */ } finally { setLoadingDispatch(false) }
                      }}
                    >
                      <RefreshCw size={11} className={loadingDispatch ? 'animate-spin' : ''}/> Actualizar
                    </button>
                  </div>
                  {loadingDispatch && !dispatch
                    ? <p className="text-xs text-gray-400 flex items-center gap-1"><Loader2 size={12} className="animate-spin"/> Cargando…</p>
                    : dispatch
                    ? <>
                        <div className={`grid gap-2 text-center text-xs ${dispatch.skipped > 0 ? 'grid-cols-5' : 'grid-cols-4'}`}>
                          <div className="bg-gray-50 rounded p-2"><p className="font-bold text-gray-700">{dispatch.total}</p><p className="text-gray-400">Total</p></div>
                          <div className="bg-yellow-50 rounded p-2"><p className="font-bold text-yellow-600">{dispatch.queued + dispatch.processing}</p><p className="text-gray-400">Pendiente</p></div>
                          <div className="bg-green-50 rounded p-2"><p className="font-bold text-green-600">{dispatch.sent}</p><p className="text-gray-400">Enviados</p></div>
                          <div className="bg-red-50 rounded p-2"><p className="font-bold text-red-500">{dispatch.failed}</p><p className="text-gray-400">Fallidos</p></div>
                          {dispatch.skipped > 0 && (
                            <div className="bg-orange-50 rounded p-2">
                              <p className="font-bold text-orange-500">{dispatch.skipped}</p>
                              <p className="text-gray-400">Omitidos</p>
                            </div>
                          )}
                        </div>
                        {dispatch.skipped > 0 && (
                          <div className="flex items-center justify-between gap-2 bg-orange-50 border border-orange-100 rounded px-2 py-1.5">
                            <p className="text-xs text-orange-600 flex items-center gap-1.5">
                              <Ban size={11}/> {dispatch.skipped} contacto{dispatch.skipped !== 1 ? 's fueron' : ' fue'} omitido{dispatch.skipped !== 1 ? 's' : ''} por límite de frecuencia (48h entre envíos).
                            </p>
                            <button
                              className="text-xs text-orange-600 underline hover:text-orange-800 whitespace-nowrap flex items-center gap-1 disabled:opacity-50"
                              disabled={freqResetting === selected.id}
                              onClick={() => resetFreq(selected)}
                            >
                              {freqResetting === selected.id
                                ? <Loader2 size={11} className="animate-spin"/>
                                : <RefreshCw size={11}/>}
                              Limpiar (pruebas)
                            </button>
                          </div>
                        )}
                        <div className="text-xs text-gray-500">
                          {dispatch.eligible_lines} línea{dispatch.eligible_lines !== 1 ? 's' : ''} elegible{dispatch.eligible_lines !== 1 ? 's' : ''} ahora
                        </div>
                        {dispatch.line_usage.length > 0 && (
                          <div className="space-y-1">
                            <p className="text-xs font-medium text-gray-600">Uso por línea</p>
                            {dispatch.line_usage.map(lu => (
                              <div key={lu.line_id} className="flex items-center gap-2 text-xs">
                                <span className="text-gray-500 truncate flex-1">{lu.display_name || lu.line_key}</span>
                                <span className="text-green-600">{lu.sent} env.</span>
                                {lu.failed > 0 && <span className="text-red-400">{lu.failed} err.</span>}
                              </div>
                            ))}
                          </div>
                        )}
                        {dispatch.top_errors && dispatch.top_errors.length > 0 && (
                          <div className="space-y-1">
                            <p className="text-xs font-medium text-red-600">Errores frecuentes</p>
                            {dispatch.top_errors.map((e, i) => (
                              <div key={i} className="flex items-start gap-2 text-xs bg-red-50 border border-red-100 rounded p-2">
                                <span className="shrink-0 font-bold text-red-500">{e.count}×</span>
                                <span className="text-red-700 break-all font-mono">{e.error}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    : <p className="text-xs text-gray-400">Sin datos de distribución</p>
                  }
                </div>
              )}

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
                                  {c.msg_status === 'failed' && c.error_detail && (
                                    <p className="text-xs text-red-500 font-mono mt-0.5 break-all max-w-xs">{c.error_detail}</p>
                                  )}
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
  const colors: Record<string, string> = { blue:'text-blue-600', green:'text-green-600', purple:'text-purple-600', red:'text-red-500', orange:'text-orange-500' }
  return (
    <div>
      <p className={`text-lg font-bold ${colors[color]}`}>{value}{pct !== undefined ? <span className="text-xs font-normal ml-0.5">{pct}%</span> : ''}</p>
      <p className="text-xs text-gray-400">{label}</p>
    </div>
  )
}

function StatBox({ label, value, color, pct }: { label: string; value: number; color: string; pct?: number }) {
  const colors: Record<string, string> = { blue:'text-blue-600 bg-blue-50', green:'text-green-600 bg-green-50', purple:'text-purple-600 bg-purple-50', red:'text-red-500 bg-red-50', orange:'text-orange-500 bg-orange-50' }
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
    skipped:   { label: 'Omitido (freq.)', className: 'text-orange-500', icon: <Ban size={12}/> },
    sending:   { label: 'Enviando…',  className: 'text-yellow-600', icon: <Loader2 size={12} className="animate-spin"/> },
    pending:   { label: 'En cola',    className: 'text-gray-400',   icon: <Clock size={12}/> },
  }
  const s = map[status] || { label: status, className: 'text-gray-500', icon: <HelpCircle size={12}/> }
  return (
    <span className={`flex items-center gap-1 text-xs font-medium ${s.className}`}>
      {s.icon} {s.label}
    </span>
  )
}
