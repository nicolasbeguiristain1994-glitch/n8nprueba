'use client'
import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Send, Plus, Loader2, Eye, Play, BarChart2, Shield, Clock, Pause, XCircle, CheckCheck, Truck, AlertTriangle, HelpCircle, Trash2, Shuffle, UserCheck, UserX, Zap, GitBranch, RefreshCw, Ban, ImageIcon, X, Upload, ListPlus } from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { CloudReadiness } from '@/components/campaigns/CloudReadiness'
import { CampaignTestSend } from '@/components/campaigns/CampaignTestSend'
import { CONTACT_NAME_VARIABLE, hasTemplateContactName, resolveTemplateContactValue } from '@/lib/campaign-personalization'

interface CampaignList { id: string; name: string; contact_count: number }
interface ProspectListOption { id: string; name: string; member_count: number }
interface CampaignContact {
  id: string; contact_id: string | null; prospect_id: string | null
  first_name: string; last_name: string; phone_number: string
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
  pause_reason: 'manual' | 'no_eligible_lines' | 'all_lines_outside_schedule' | 'systemic_error' | 'config_missing' | 'frequency_exhausted' | 'assigned_line_unavailable' | 'unknown' | null
  processor_locked_at: string | null
  // Opcionales: sólo presentes si la API los devuelve
  message_type?: 'text' | 'template' | null
  template_id?: string | null
  template_name?: string | null
}
interface TemplateButton { type?: string; text?: string; url?: string }
interface TemplateComponent { type?: string; format?: string; text?: string; buttons?: TemplateButton[] }
interface WaTemplate {
  id: string; name: string; language: string | null; status: string
  waba_id: string | null; components: TemplateComponent[] | string | null
}
type TemplateHeaderType = 'image' | 'video' | 'document'
interface TemplateAnalysis {
  bodyText: string
  bodyCount: number
  header: TemplateHeaderType | null
  buttons: { index: number; sub_type: 'url' | 'quick_reply'; label: string; required: boolean }[]
  unsupported: string[]
}
interface TemplateParams {
  body?: string[]
  header?: { type: TemplateHeaderType; link: string }
  buttons?: { index: number; sub_type: 'url' | 'quick_reply'; payload: string }[]
}
interface DispatchSummary {
  total: number; queued: number; processing: number
  sent: number; failed: number; skipped: number
  eligible_lines: number
  line_usage: { line_id: string; line_key: string; display_name: string; sent: number; failed: number }[]
  top_errors?: { error: string; count: number }[]
}

const STATUS_BADGE: Record<string, string> = {
  draft:      'bg-muted text-muted-foreground',
  scheduled:  'bg-blue-100 text-blue-700',
  running:    'bg-yellow-100 text-yellow-700',
  completed:  'bg-success/15 text-success',
  paused:     'bg-orange-100 text-orange-700',
  cancelled:  'bg-destructive/15 text-destructive',
}

const STATUS_LABEL: Record<string, string> = {
  draft:     'Borrador',
  scheduled: 'Programado',
  running:   'Enviando',
  completed: 'Completado',
  paused:    'Pausado',
  cancelled: 'Cancelado',
}

const AR_TZ = 'America/Argentina/Buenos_Aires'

function formatAR(iso: string) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return `${d.toLocaleString('es-AR', { timeZone: AR_TZ })} (hora Argentina)`
}

// datetime-local ("YYYY-MM-DDTHH:mm") → ISO con offset explícito de Argentina (-03:00, sin horario de verano)
function toArgentinaIso(local: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/.exec(local.trim())
  if (!m) return null
  return `${m[1]}T${m[2]}${m[3] ?? ':00'}-03:00`
}

const HEADER_LABEL: Record<TemplateHeaderType, string> = { image: 'imagen', video: 'video', document: 'documento' }

// Determina qué parámetros pide la plantilla y qué componentes no se pueden enviar desde campañas.
// Replica las reglas de validateCampaignTemplate (lib/campaign-template.ts): tipos exactos en mayúsculas,
// variables de cuerpo {{1}}…{{N}} consecutivas y URL dinámica sólo con {{1}} al final.
function analyzeTemplate(tpl: WaTemplate): TemplateAnalysis {
  let raw: unknown = tpl.components
  if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { raw = null } }
  const res: TemplateAnalysis = { bodyText: '', bodyCount: 0, header: null, buttons: [], unsupported: [] }
  if (!Array.isArray(raw)) {
    res.unsupported.push('La plantilla no tiene componentes válidos')
    return res
  }
  const comps: TemplateComponent[] = raw
  let hasBody = false
  for (const c of comps) {
    const type = c?.type ?? ''
    if (type === 'BODY') {
      if (hasBody) continue  // el backend sólo considera el primer cuerpo
      hasBody = true
      res.bodyText = c.text ?? ''
      const vars = [...new Set([...res.bodyText.matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1]))]
      const consecutive = vars.every(v => /^[1-9]\d*$/.test(v) && Number(v) <= vars.length)
      if (!consecutive) {
        res.unsupported.push(`Cuerpo con variables no compatibles (${vars.map(v => `{{${v}}}`).join(', ')}); sólo se admiten {{1}}, {{2}}… consecutivas`)
      } else if (vars.length > 30) {
        res.unsupported.push('Cuerpo con más de 30 variables')
      } else {
        res.bodyCount = vars.length
      }
    } else if (type === 'HEADER') {
      const format = c.format ?? ''
      if (format === 'IMAGE' || format === 'VIDEO' || format === 'DOCUMENT') {
        res.header = format.toLowerCase() as TemplateHeaderType
      } else if (format === 'TEXT') {
        if (/\{\{/.test(c.text ?? '')) res.unsupported.push('Encabezado de texto con variables')
      } else {
        res.unsupported.push(format ? `Encabezado de tipo ${format}` : 'Encabezado sin formato indicado')
      }
    } else if (type === 'FOOTER') {
      // Texto fijo: no requiere parámetros
    } else if (type === 'BUTTONS') {
      (Array.isArray(c.buttons) ? c.buttons : []).forEach((b, index) => {
        const bt = b?.type ?? ''
        const label = b?.text || `Botón ${index + 1}`
        if (bt === 'URL') {
          const url = b.url ?? ''
          if (!/\{\{/.test(url)) return  // URL fija: sin parámetros
          if (!/\{\{1\}\}$/.test(url) || (url.match(/\{\{/g)?.length ?? 0) !== 1) {
            res.unsupported.push(`Botón "${label}" con URL dinámica no compatible (sólo {{1}} al final)`)
          } else {
            res.buttons.push({ index, sub_type: 'url', label, required: true })
          }
        } else if (bt === 'QUICK_REPLY') {
          res.buttons.push({ index, sub_type: 'quick_reply', label, required: false })
        } else if (bt !== 'PHONE_NUMBER') {
          res.unsupported.push(`Botón "${label}" de tipo ${bt || 'desconocido'}`)
        }
      })
    } else {
      res.unsupported.push(`Componente ${type || 'desconocido'}`)
    }
  }
  if (!hasBody) res.unsupported.push('La plantilla no tiene cuerpo (BODY) legible')
  return res
}

// Límites de CampaignTemplateParamsSchema
const MAX_BODY_PARAM = 1024
const MAX_URL_LENGTH = 2048

// Pausa entre envíos de la campaña (antiblock_delay_min/max), en segundos
const DELAY_MIN_SECONDS = 3
const DELAY_MAX_SECONDS = 300

function buildTemplateParams(
  a: TemplateAnalysis, body: string[], headerLink: string, buttons: Record<number, string>,
): { params: TemplateParams; missing: string[]; invalid: string[] } {
  const params: TemplateParams = {}
  const missing: string[] = []
  const invalid: string[] = []
  if (a.bodyCount > 0) {
    params.body = Array.from({ length: a.bodyCount }, (_, i) => (body[i] ?? '').trim())
    params.body.forEach((v, i) => {
      if (!v) missing.push(`parámetro {{${i + 1}}} del cuerpo`)
      else if (v.length > MAX_BODY_PARAM) invalid.push(`el parámetro {{${i + 1}}} del cuerpo supera ${MAX_BODY_PARAM} caracteres`)
    })
  }
  if (a.header) {
    const link = headerLink.trim()
    if (!/^https:\/\/\S+$/i.test(link)) missing.push(`URL https del encabezado (${HEADER_LABEL[a.header]})`)
    else if (link.length > MAX_URL_LENGTH) invalid.push(`la URL del encabezado supera ${MAX_URL_LENGTH} caracteres`)
    params.header = { type: a.header, link }
  }
  const btns = a.buttons
    .map(b => ({ index: b.index, sub_type: b.sub_type, payload: (buttons[b.index] ?? '').trim(), required: b.required, label: b.label }))
  btns.forEach(b => {
    if (b.required && !b.payload) missing.push(`valor del botón "${b.label}"`)
    else if (b.payload.length > MAX_URL_LENGTH) invalid.push(`el valor del botón "${b.label}" supera ${MAX_URL_LENGTH} caracteres`)
  })
  const filled = btns.filter(b => b.payload).map(({ index, sub_type, payload }) => ({ index, sub_type, payload }))
  if (filled.length) params.buttons = filled
  return { params, missing, invalid }
}

function fillTemplatePreview(text: string, values: string[]) {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => {
    const value = values[Number(n) - 1]?.trim()
    return value ? resolveTemplateContactValue(value, { first_name: 'pablo', phone_number: '[teléfono del contacto]' }, true) : m
  })
}

export default function Campaigns() {
  const { user, permissions } = useCurrentUser()
  const isAdmin  = user?.role === 'admin'

  const [campaigns, setCampaigns]         = useState<Campaign[]>([])
  const [campaignsLoaded, setCampaignsLoaded]   = useState(false)
  const [campaignsLoading, setCampaignsLoading] = useState(true)
  const [campaignsError, setCampaignsError]     = useState<string | null>(null)
  const [schedulerEnabled, setSchedulerEnabled] = useState(false)
  const [lookupFailures, setLookupFailures]     = useState<string[]>([])
  const [lists, setLists]                 = useState<CampaignList[]>([])
  const [prospectLists, setProspectLists] = useState<ProspectListOption[]>([])
  const [showNew, setShowNew]             = useState(false)
  const canOpenNew = isAdmin || (permissions?.campaigns?.includes('create') ?? false)
  useEffect(() => {
    if (!canOpenNew) return
    const open = () => setShowNew(true)
    const url = new URL(window.location.href)
    if (url.searchParams.get('action') === 'new') {
      open(); url.searchParams.delete('action'); window.history.replaceState(null, '', url)
    }
    window.addEventListener('cmd:new-campaign', open)
    return () => window.removeEventListener('cmd:new-campaign', open)
  }, [canOpenNew])

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
  const [contactStatusFilter, setContactStatusFilter] = useState<string>('all')
  const [dispatchError, setDispatchError]             = useState<string | null>(null)
  // Identificador de la última apertura de detalle: descarta respuestas de campañas anteriores
  const detailReqRef    = useRef(0)
  const campaignsReqRef = useRef(0)

  const FORM_DEFAULT = {
    name: '', list_id: '', prospect_list_id: '', audience_type: 'contacts' as 'contacts' | 'prospects',
    scheduled_at: '',
    media_url: '', antiblock_delay_min: 3, antiblock_delay_max: 8,
    type: 'promotion', personalize_name: true, use_multi_line: true,
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
  const [templateList,     setTemplateList]     = useState<WaTemplate[]>([])
  const [templatesStatus,  setTemplatesStatus]  = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [selectedTemplate, setSelectedTemplate] = useState<string>('')
  const [tplBody,       setTplBody]       = useState<string[]>([])
  const [tplHeaderLink, setTplHeaderLink] = useState('')
  const [tplButtons,    setTplButtons]    = useState<Record<number, string>>({})

  // Cargar plantillas aprobadas cuando se abre el modal. Sólo sirven las que tienen WABA asociada.
  const loadTemplates = useCallback(() => {
    setTemplatesStatus('loading')
    fetchJson<{ templates: WaTemplate[] }>('/api/templates?status=APROBADA')
      .then(d => {
        setTemplateList((d.templates || []).filter(t =>
          t && t.waba_id != null && String(t.waba_id).trim() !== '' && (!t.status || t.status === 'APROBADA')))
        setTemplatesStatus('ready')
      })
      .catch(() => setTemplatesStatus('error'))
  }, [])

  // Importa a la base local el catálogo de las WABAs Cloud accesibles. No crea plantillas en Meta ni envía mensajes.
  const [syncingTemplates, setSyncingTemplates] = useState(false)
  const [templateSyncMsg,  setTemplateSyncMsg]  = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const syncTemplatesFromMeta = async () => {
    setSyncingTemplates(true)
    setTemplateSyncMsg(null)
    try {
      const res = await fetch('/api/templates/sync-cloud', { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (res.ok) {
        setTemplateSyncMsg({ kind: 'ok', text: `Se sincronizaron ${d.synced ?? 0} plantillas de ${d.accounts ?? 0} cuentas WABA.` })
        loadTemplates()
      } else {
        // 502 con synced: sincronización parcial; se recarga lo que sí se importó
        const partial = typeof d.synced === 'number'
        setTemplateSyncMsg({
          kind: 'error',
          text: `${d.error || `Error ${res.status}`}${partial ? ` (sincronización parcial: ${d.synced} plantillas importadas)` : ''}`,
        })
        if (partial) loadTemplates()
      }
    } catch {
      setTemplateSyncMsg({ kind: 'error', text: 'Error de red al sincronizar plantillas desde Meta' })
    } finally {
      setSyncingTemplates(false)
    }
  }

  const selectedTpl  = templateList.find(t => t.id === selectedTemplate) ?? null
  const tplAnalysis  = useMemo(() => selectedTpl ? analyzeTemplate(selectedTpl) : null, [selectedTpl])
  const tplBuild     = tplAnalysis ? buildTemplateParams(tplAnalysis, tplBody, tplHeaderLink, tplButtons) : null
  const templateReady = !!tplAnalysis && tplAnalysis.unsupported.length === 0 &&
    tplBuild?.missing.length === 0 && tplBuild.invalid.length === 0

  // Sólo campañas: se usa tras cada acción. Un fallo conserva la última lista conocida.
  const loadCampaigns = useCallback(() => {
    const req = ++campaignsReqRef.current
    setCampaignsLoading(true)
    fetchJson<{ campaigns: Campaign[]; scheduler_enabled?: boolean }>('/api/campaigns')
      .then(d => {
        if (req !== campaignsReqRef.current) return
        if (!Array.isArray(d?.campaigns)) throw new Error('respuesta inválida del servidor')
        const list = d.campaigns
        setCampaigns(list)
        setSchedulerEnabled(d.scheduler_enabled === true)
        setCampaignsLoaded(true)
        setCampaignsError(null)
        setSelected(prev => prev ? (list.find(c => c.id === prev.id) ?? prev) : prev)
      })
      .catch(err => {
        if (req !== campaignsReqRef.current) return
        setCampaignsError(`No se pudieron cargar las campañas${err instanceof Error ? ` (${err.message})` : ''}`)
      })
      .finally(() => { if (req === campaignsReqRef.current) setCampaignsLoading(false) })
  }, [])

  // Listas: al montar y cuando cambian (no en cada refresco de estado de campañas)
  const loadLookups = useCallback(() => {
    const failed: string[] = []
    const track = <T,>(p: Promise<T>, label: string, apply: (v: T) => void) =>
      p.then(apply).catch(() => { failed.push(label) })
    Promise.all([
      track(fetchJson<{ lists: CampaignList[] }>('/api/lists'), 'listas de contactos', d => setLists(d.lists || [])),
      track(fetchJson<{ lists: ProspectListOption[] }>('/api/prospect-lists?limit=100'), 'listas de difusión', d => setProspectLists(d.lists || [])),
    ]).then(() => setLookupFailures(failed))
  }, [])

  useEffect(() => { loadCampaigns(); loadLookups() }, [loadCampaigns, loadLookups])

  const resetTemplateState = () => {
    setUseTemplate(false)
    setSelectedTemplate('')
    setTplBody([]); setTplHeaderLink(''); setTplButtons({})
    setTemplateSyncMsg(null)
  }

  const createCampaign = async () => {
    setCreateError(null)
    const validMsgs = messages.filter(m => m.trim())
    const delayMin = form.antiblock_delay_min
    const delayMax = form.antiblock_delay_max
    const validDelay = (n: number) => Number.isInteger(n) && n >= DELAY_MIN_SECONDS && n <= DELAY_MAX_SECONDS
    if (!validDelay(delayMin) || !validDelay(delayMax)) {
      setCreateError(`Las pausas deben ser números enteros entre ${DELAY_MIN_SECONDS} y ${DELAY_MAX_SECONDS} segundos`)
      return
    }
    if (delayMin > delayMax) {
      setCreateError('La pausa mínima no puede ser mayor que la pausa máxima')
      return
    }
    let scheduledAt: string | null = null
    if (form.scheduled_at && schedulerEnabled) {
      scheduledAt = toArgentinaIso(form.scheduled_at)
      if (!scheduledAt) { setCreateError('Fecha de programación inválida'); return }
    }
    if (useTemplate) {
      if (!selectedTpl || !tplAnalysis || !tplBuild) { setCreateError('Seleccioná una plantilla aprobada'); return }
      if (tplAnalysis.unsupported.length) { setCreateError('La plantilla tiene componentes no compatibles; no se puede crear la campaña'); return }
      if (tplBuild.missing.length) { setCreateError(`Falta completar: ${tplBuild.missing.join(', ')}`); return }
      if (tplBuild.invalid.length) { setCreateError(`Corregí: ${tplBuild.invalid.join(', ')}`); return }
    }
    setCreating(true)
    let res: Response
    try {
      const base: Record<string, unknown> = {
        ...form,
        scheduled_at: scheduledAt,
        antiblock_delay_min: delayMin,
        antiblock_delay_max: delayMax,
        // Audiencia: solo uno de los dos debe ir en el payload
        list_id:          form.audience_type === 'contacts'  ? (form.list_id          || null) : null,
        prospect_list_id: form.audience_type === 'prospects' ? (form.prospect_list_id || null) : null,
      }
      let payload: Record<string, unknown>
      if (useTemplate && tplBuild) {
        // Plantilla: sin texto libre, variantes ni imagen suelta; siempre por el distribuidor multi-línea
        const rest = { ...base }
        delete rest.media_url
        payload = {
          ...rest,
          message_type: 'template',
          template_id: selectedTemplate,
          template_params: tplBuild.params,
          use_multi_line: true,
          personalize_name: false,
        }
      } else {
        payload = { ...base, message_type: 'text', messages: validMsgs, message: validMsgs[0] }
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
    resetTemplateState()
    loadCampaigns()
  }

  // La plantilla no reemplaza los mensajes de texto: se envía como template con sus parámetros
  const onSelectTemplate = (tplId: string | null) => {
    if (!tplId || tplId.startsWith('_')) return
    setSelectedTemplate(tplId)
    setTplBody([]); setTplHeaderLink(''); setTplButtons({})
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
          loadCampaigns()
        } else {
          setSendError(d.error || `Error ${res.status}`)
        }
      } else {
        setTimeout(loadCampaigns,1000)
      }
    } catch {
      setSendError('Error de red al enviar')
    } finally {
      setSending(null)
    }
  }

  const resetFreq = async (campaign: Campaign) => {
    if (!confirm(`¿Reiniciar los destinatarios sin envío de "${campaign.name}"?\n\nEl historial se conservará. Si hay mensajes aceptados o pendientes de confirmación, el reinicio se bloqueará: creá una campaña nueva para un nuevo envío.`)) return
    setFreqResetting(campaign.id)
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/freq-reset`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm_reset: true }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setSendError(d.error || 'Error al resetear campaña')
      } else {
        setSendError(null)
        // Cerrar el modal si está abierto y recargar la lista
        if (selected?.id === campaign.id) closeDetail()
        loadCampaigns()
      }
    } catch {
      setSendError('Error de red al limpiar frecuencia')
    } finally {
      setFreqResetting(null)
    }
  }

  const retryFailed = async (campaign: Campaign) => {
    if (!confirm(`¿Reintentar los fallos confirmados y los omitidos por frecuencia de "${campaign.name}"?\n\nLos fallos confirmados no consumirán el límite de frecuencia. Se conservará el historial y se excluirán los mensajes entregados o pendientes de confirmación. Los omitidos volverán a evaluarse con los límites vigentes.`)) return
    setRetryingFailed(campaign.id)
    setSendError(null)
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/retry-failed`, { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setSendError(d.error || 'Error al preparar reintento')
      } else {
        setSendError(null)
        loadCampaigns()
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
      const isProspectCampaign = !!campaign.prospect_list_id

      let res: Response
      if (isProspectCampaign) {
        const ids = failed.map(c => c.prospect_id).filter(Boolean) as string[]
        if (ids.length === 0) {
          setFailedListMsg('No se encontraron prospectos válidos para crear la lista')
          return
        }
        res = await fetch('/api/prospect-lists/from-selection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, prospect_ids: ids }),
        })
      } else {
        const ids = failed.map(c => c.contact_id).filter(Boolean) as string[]
        if (ids.length === 0) {
          setFailedListMsg('No se encontraron contactos válidos para crear la lista')
          return
        }
        res = await fetch('/api/lists', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, contact_ids: ids }),
        })
      }
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setFailedListMsg(`Error: ${d.error || 'No se pudo crear la lista'}`)
      } else {
        setFailedListMsg(`Lista "${name}" creada con ${failed.length} contacto${failed.length !== 1 ? 's' : ''}.`)
        loadLookups()
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
          loadCampaigns()
        } else {
          setSendError(d.error || `Error al reanudar`)
        }
      } else {
        setTimeout(loadCampaigns,1500)
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
        loadCampaigns()
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
      const response = await fetch(`/api/campaigns/${campaign.id}/sync-status`, { method: 'POST' })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) { setSendError(result.error || 'No se pudieron sincronizar los estados'); return }
      setSendError(null)
      loadCampaigns()
    } catch { setSendError('Error de red al sincronizar estados') } finally {
      setSyncing(null)
    }
  }

  const loadDispatch = async (id: string, req: number) => {
    setLoadingDispatch(true)
    setDispatchError(null)
    try {
      const d = await fetchJson<DispatchSummary>(`/api/campaigns/${id}/dispatch`)
      if (req !== detailReqRef.current) return
      setDispatch({ ...d, line_usage: Array.isArray(d.line_usage) ? d.line_usage : [] })
    } catch {
      if (req === detailReqRef.current) setDispatchError('No se pudo cargar el progreso de distribución')
    } finally {
      if (req === detailReqRef.current) setLoadingDispatch(false)
    }
  }

  const openDetail = async (c: Campaign) => {
    const req = ++detailReqRef.current
    setSelected(c)
    setCampContacts([])
    setDetailError(null)
    setDispatch(null)
    setDispatchError(null)
    setLoadingDispatch(false)
    setFailedListMsg(null)
    setContactStatusFilter('all')
    setLoadingContacts(true)

    // Fetch contacts and (for multi-line) dispatch summary in parallel.
    // Si mientras tanto se abre otra campaña, las respuestas tardías se descartan.
    const contactsFetch = fetch(`/api/campaigns/${c.id}/contacts`)
      .then(async r => {
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(d.error || `Error ${r.status}`)
        if (req === detailReqRef.current) setCampContacts(d.contacts || [])
      })
      .catch(err => {
        if (req === detailReqRef.current) setDetailError(err instanceof Error ? err.message : 'Error al cargar destinatarios')
      })
      .finally(() => { if (req === detailReqRef.current) setLoadingContacts(false) })

    const dispatchFetch = c.use_multi_line ? loadDispatch(c.id, req) : Promise.resolve()

    await Promise.all([contactsFetch, dispatchFetch])
  }

  const closeDetail = () => {
    detailReqRef.current++
    setSelected(null)
    setDetailError(null)
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
        loadCampaigns()
      }
    } catch {
      setSendError('Error de red al actualizar estado')
    }
    setActioning(null)
  }

  const previewName = form.personalize_name ? 'Juan' : ''
  const previewMsg = (messages[previewIdx] || '').replace(/\{\{nombre\}\}/gi, previewName).replace(/\{\{name\}\}/gi, previewName)

  const openNew = () => {
    if (lookupFailures.length) loadLookups()
    setShowNew(true)
  }

  const canCreate = !creating && !!form.name.trim() &&
    (useTemplate ? templateReady : messages.some(m => m.trim()))

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-title">Campañas</h1>
          <p className="text-sm text-muted-foreground">
            {campaignsLoaded ? `${campaigns.length} campañas` : campaignsLoading ? 'Cargando…' : 'Sin datos'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={loadCampaigns} disabled={campaignsLoading}>
            <RefreshCw size={13} className={`mr-1 ${campaignsLoading ? 'animate-spin' : ''}`} /> Actualizar
          </Button>
          <Button onClick={openNew} className="bg-primary hover:bg-primary/90" size="sm">
            <Plus size={14} className="mr-1" /> Nueva campaña
          </Button>
        </div>
      </div>

      <CloudReadiness />

      {/* Error de carga: no se vacía la lista ni se muestra "sin campañas" */}
      {campaignsError && (
        <div role="alert" className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-2 text-sm text-destructive flex items-center justify-between gap-3">
          <span>
            {campaignsError}.
            {campaignsLoaded && ' Se muestran los últimos datos cargados.'}
          </span>
          <Button variant="outline" size="sm" onClick={loadCampaigns} disabled={campaignsLoading}>Reintentar</Button>
        </div>
      )}

      {/* Error de envío */}
      {sendError && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-2 text-sm text-destructive flex items-center justify-between">
          <span>{sendError}</span>
          <button onClick={() => setSendError(null)} className="ml-4 text-red-400 hover:text-destructive">✕</button>
        </div>
      )}

      {/* Lista de campañas */}
      {!campaignsLoaded
        ? (campaignsError
            ? null
            : <Card><CardContent className="py-16 text-center text-muted-foreground flex items-center justify-center gap-2">
                <Loader2 size={16} className="animate-spin" /> Cargando campañas…
              </CardContent></Card>)
        : campaigns.length === 0
        ? <Card><CardContent className="py-16 text-center text-muted-foreground">
            <BarChart2 size={32} className="mx-auto mb-3 opacity-30" />
            <p>No hay campañas todavía</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={openNew}>Crear la primera</Button>
          </CardContent></Card>
        : <div className="space-y-3">
            {campaigns.map(c => (
              <Card key={c.id} className="hover:shadow-sm transition-shadow">
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[c.status] || ''}`}>
                          {STATUS_LABEL[c.status] ?? c.status}
                        </span>
                        {c.use_multi_line && (
                          <span className="text-xs bg-accent text-primary px-1.5 py-0.5 rounded-full flex items-center gap-1">
                            <GitBranch size={10}/> multi-línea
                          </span>
                        )}
                        {c.scheduled_at && c.status === 'scheduled' && (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Clock size={11}/> {formatAR(c.scheduled_at)}
                          </span>
                        )}
                        {c.status === 'scheduled' && !schedulerEnabled && (
                          <span className="text-xs text-orange-500">Programación automática no habilitada: requiere envío manual</span>
                        )}
                      </div>
                      <h3 className="font-medium truncate">{c.name}</h3>
                      <div className="flex items-center gap-2">
                        {c.message_type === 'template'
                          ? <p className="text-sm text-muted-foreground truncate">Plantilla de WhatsApp{c.template_name ? `: ${c.template_name}` : ''}</p>
                          : <p className="text-sm text-muted-foreground truncate">{c.message}</p>}
                        {c.message_type !== 'template' && Array.isArray(c.messages) && c.messages.length > 1 && (
                          <span className="text-xs bg-accent text-primary px-1.5 py-0.5 rounded-full whitespace-nowrap flex items-center gap-1 shrink-0">
                            <Shuffle size={10} /> {c.messages.length} variantes
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs text-muted-foreground">
                        {(c.list_name || c.prospect_list_name) && (
                          <span>Lista: <b className="text-muted-foreground">{c.list_name || c.prospect_list_name}</b></span>
                        )}
                        <span>{c.total_targets} dest.</span>
                        <span className="flex items-center gap-1"><Shield size={10}/> {c.antiblock_delay_min}-{c.antiblock_delay_max}s</span>
                        {c.personalize_name
                          ? <span className="flex items-center gap-1 text-success"><UserCheck size={10}/> con nombre</span>
                          : <span className="flex items-center gap-1 text-muted-foreground"><UserX size={10}/> sin nombre</span>
                        }
                      </div>
                    </div>

                    {/* Métricas inline */}
                    {(c.total_sent > 0 || c.total_skipped > 0 || c.total_failed > 0) && (
                      <div className="flex max-w-full flex-wrap gap-4 text-center">
                        <MiniStat label="Enviados"   value={c.total_sent}      color="blue" />
                        <MiniStat label="Entregados" value={c.total_delivered} color="green" />
                        <MiniStat label="Leídos"     value={c.total_read}      pct={c.read_rate} color="purple" />
                        {c.total_failed  > 0 && <MiniStat label="Fallidos"       value={c.total_failed}  color="red" />}
                        {c.total_skipped > 0 && <MiniStat label="Omitidos" value={c.total_skipped} color="orange" />}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2 shrink-0">
                      <Button variant="outline" size="sm" onClick={() => openDetail(c)} aria-label={`Ver detalle de ${c.name}`}>
                        <Eye size={13} />
                      </Button>

                      {/* Enviar: draft, scheduled */}
                      {(c.status === 'draft' || c.status === 'scheduled') && (c.list_name || c.prospect_list_name) && (
                        <Button size="sm" className="bg-primary hover:bg-primary/90"
                                onClick={() => sendNow(c)} disabled={sending === c.id}>
                          {sending === c.id
                            ? <Loader2 size={13} className="animate-spin"/>
                            : <><Play size={13} className="mr-1"/>Enviar</>}
                        </Button>
                      )}

                      {/* Reanudar: paused */}
                      {c.status === 'paused' && (c.list_name || c.prospect_list_name) && (
                        <Button size="sm" className="bg-primary hover:bg-primary/90"
                                onClick={() => c.use_multi_line ? resumeProcessor(c.id) : sendNow(c)}
                                disabled={sending === c.id || resuming === c.id}>
                          {(sending === c.id || resuming === c.id)
                            ? <Loader2 size={13} className="animate-spin"/>
                            : <><Play size={13} className="mr-1"/>Reanudar</>}
                        </Button>
                      )}

                      {/* Verificar / completar: running con todos los contactos ya enviados */}
                      {c.status === 'running' && c.total_sent > 0 && c.use_multi_line && (
                        <Button size="sm" className="bg-primary hover:bg-primary/90"
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
                                className="border-destructive/20 text-red-500 hover:bg-destructive/10"
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
                      {['completed','paused'].includes(c.status) && !c.processor_locked_at && (c.total_failed > 0 || c.total_skipped > 0) && (
                        <Button size="sm" variant="outline"
                                className="border-destructive/20 text-destructive hover:bg-destructive/10"
                                title="Reintentar fallidos y omitidos por frecuencia"
                                onClick={() => retryFailed(c)}
                                disabled={retryingFailed === c.id || resuming === c.id}>
                          {retryingFailed === c.id
                            ? <Loader2 size={13} className="animate-spin"/>
                            : <span className="text-xs font-bold">Reintentar</span>}
                        </Button>
                      )}

                      {/* Reinicio de destinatarios sin envío; conserva el historial */}
                      {isAdmin && ['completed','paused','cancelled'].includes(c.status) && !c.processor_locked_at && (c.total_sent > 0 || c.total_skipped > 0 || c.total_failed > 0) && (
                        <Button size="sm" variant="outline"
                                className="border-orange-200 text-orange-500 hover:bg-orange-50"
                                title="Reiniciar destinatarios sin envío confirmado (admin)"
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
                          <>Pausado manualmente. <span className="text-muted-foreground">Presioná Reanudar para continuar.</span></>
                        )}
                        {c.pause_reason === 'no_eligible_lines' && (() => {
                          const pending = c.total_targets - c.total_sent - c.total_failed - c.total_skipped
                          return <>{pending} destinatarios pendientes — sin líneas activas o con cuota agotada. <span className="text-muted-foreground">Reconectá líneas o esperá que se reinicien los contadores, luego reanudar.</span></>
                        })()}
                        {c.pause_reason === 'assigned_line_unavailable' && (
                          <>Hay clientes pendientes cuya línea habitual no está disponible o no tiene cupo. Se conserva su número de contacto. Reanudá cuando esa línea vuelva a estar disponible.</>
                        )}
                        {c.pause_reason === 'all_lines_outside_schedule' && (() => {
                          const pending = c.total_targets - c.total_sent - c.total_failed - c.total_skipped
                          return <>{pending} destinatarios pendientes — todas las líneas fuera de su ventana de horario. <span className="text-muted-foreground">Reanudá cuando las líneas entren en horario.</span></>
                        })()}
                        {c.pause_reason === 'systemic_error' && (() => {
                          const pending = c.total_targets - c.total_sent - c.total_failed - c.total_skipped
                          return <>{pending} destinatarios pendientes — error sistémico del procesador. <span className="text-muted-foreground">Revisá los logs antes de reanudar. Si el problema persiste, contactá soporte.</span></>
                        })()}
                        {c.pause_reason === 'config_missing' && (
                          <>No se pudo iniciar con la configuración actual. <span className="text-muted-foreground">Revisá la lista, los permisos del responsable y la conexión o plantilla de WhatsApp antes de reanudar.</span></>
                        )}
                        {c.pause_reason === 'frequency_exhausted' && (
                          <>Todos los contactos bloqueados por límite de frecuencia. <span className="text-muted-foreground">Los contactos podrán recibir mensajes en la siguiente ventana (24h/7d).</span></>
                        )}
                        {(c.pause_reason === 'unknown' || !c.pause_reason) && (() => {
                          const pending = c.total_targets - c.total_sent - c.total_failed - c.total_skipped
                          return pending > 0
                            ? <>{pending} destinatarios pendientes — pausado automáticamente. <span className="text-muted-foreground">Reanudar para continuar.</span></>
                            : <>Pausado.</>
                        })()}
                      </span>
                    </div>
                  )}

                  {/* Force-unlock para admin: campaña en running con lock activo */}
                  {isAdmin && ['running','paused'].includes(c.status) && c.processor_locked_at && (() => {
                    const lockedMs = Date.now() - new Date(c.processor_locked_at).getTime()
                    const lockedMin = Math.floor(lockedMs / 60_000)
                    if (lockedMin < 20) return null  // lock reciente, no mostramos
                    return (
                      <div className="mt-2 flex items-center gap-2 text-xs text-red-500">
                        <AlertTriangle size={11} className="shrink-0" />
                        <span>Procesador bloqueado hace {lockedMin} min sin progreso evidente.</span>
                        <button
                          className="underline hover:text-destructive disabled:opacity-50 whitespace-nowrap"
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
                      <div className="flex justify-between text-xs text-muted-foreground mb-1">
                        <span>Enviando…</span>
                        <span>{c.total_sent + c.total_failed + c.total_skipped}/{c.total_targets}</span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-1.5">
                        <div className="bg-green-500 h-1.5 rounded-full transition-all"
                             style={{ width: `${Math.min(100, Math.max(0, ((c.total_sent + c.total_failed + c.total_skipped)/c.total_targets)*100))}%` }} />
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
          resetTemplateState()
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
              <label htmlFor="campaign-name" className="text-xs font-medium text-muted-foreground mb-1 block">Nombre de campaña</label>
              <Input
                id="campaign-name" placeholder="Ej: Retención VIP Mayo, Promo Slots Junio…"
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
                  setSelectedTemplate('')
                  setTplBody([]); setTplHeaderLink(''); setTplButtons({})
                  setTemplateSyncMsg(null)
                  if (next) loadTemplates()
                }}
                className={`flex items-center gap-3 w-full rounded-lg border px-4 py-3 text-sm transition-colors ${
                  useTemplate
                    ? 'border-success/20 bg-success/10 text-success'
                    : 'border-border bg-background text-muted-foreground'
                }`}
              >
                <div className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${useTemplate ? 'bg-green-500' : 'bg-gray-300'}`}>
                  <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-card shadow transition-transform ${useTemplate ? 'translate-x-4' : ''}`} />
                </div>
                {useTemplate ? 'Usar plantilla aprobada activado' : 'Usar plantilla aprobada (opcional)'}
              </button>
              {useTemplate && (
                <div className="mt-2 space-y-3">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      {templatesStatus === 'error' ? (
                        <p role="alert" className="text-xs text-destructive flex items-center gap-1">
                          <AlertTriangle size={11} /> No se pudieron cargar las plantillas.
                          <button type="button" onClick={loadTemplates} className="underline">Reintentar</button>
                        </p>
                      ) : (
                        <Select
                          value={selectedTemplate}
                          onValueChange={onSelectTemplate}
                          items={templateList.map(t => ({ value: t.id, label: `${t.name} · ${t.language || 'idioma no indicado'}` }))}
                        >
                          <SelectTrigger className="text-sm"><SelectValue placeholder="Seleccionar plantilla…" /></SelectTrigger>
                          <SelectContent>
                            {templatesStatus === 'loading'
                              ? <SelectItem value="_loading" disabled>Cargando plantillas…</SelectItem>
                              : templateList.length === 0
                              ? <SelectItem value="_none" disabled>No hay plantillas aprobadas con cuenta WABA</SelectItem>
                              : templateList.map(t => (
                                  <SelectItem key={t.id} value={t.id}>{t.name} · {t.language || 'idioma no indicado'}</SelectItem>
                                ))
                            }
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                    <Button type="button" variant="outline" size="sm" className="shrink-0"
                            onClick={syncTemplatesFromMeta}
                            disabled={syncingTemplates || templatesStatus === 'loading'}>
                      <RefreshCw size={13} className={`mr-1 ${syncingTemplates ? 'animate-spin' : ''}`} />
                      {syncingTemplates ? 'Sincronizando…' : 'Sincronizar desde Meta'}
                    </Button>
                  </div>
                  {templatesStatus === 'ready' && templateList.length === 0 && !templateSyncMsg && (
                    <p className="text-xs text-orange-500">
                      No hay plantillas locales. Usá &quot;Sincronizar desde Meta&quot; para importar el catálogo de tus cuentas WhatsApp Cloud.
                    </p>
                  )}
                  {templateSyncMsg && (
                    templateSyncMsg.kind === 'error'
                      ? <p role="alert" className="text-xs text-destructive flex items-center gap-1"><AlertTriangle size={11} /> {templateSyncMsg.text}</p>
                      : <p role="status" className="text-xs text-success">{templateSyncMsg.text}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Se envía como plantilla de WhatsApp Cloud API por el distribuidor multi-línea. Sólo se listan plantillas aprobadas con cuenta WABA asociada.
                    La sincronización sólo importa el catálogo existente en Meta: no crea plantillas ni envía mensajes.
                  </p>

                  {selectedTpl && tplAnalysis && (tplAnalysis.unsupported.length > 0 ? (
                    <div role="alert" className="bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2 text-xs text-destructive space-y-1">
                      <p className="font-medium flex items-center gap-1"><AlertTriangle size={12} /> Esta plantilla no se puede usar en campañas todavía</p>
                      <ul className="list-disc pl-5">
                        {tplAnalysis.unsupported.map((u, i) => <li key={i}>{u}</li>)}
                      </ul>
                      <p>No se admite la creación con esta plantilla. Elegí otra o usá un mensaje de texto.</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {tplAnalysis.header && (
                        <div>
                          <label htmlFor="tpl-header-link" className="text-xs font-medium text-muted-foreground mb-1 block">
                            URL del encabezado ({HEADER_LABEL[tplAnalysis.header]})
                          </label>
                          <Input id="tpl-header-link" placeholder="https://…" value={tplHeaderLink}
                                 onChange={e => setTplHeaderLink(e.target.value)} />
                        </div>
                      )}
                      {Array.from({ length: tplAnalysis.bodyCount }, (_, i) => (
                        <div key={i}>
                          <label htmlFor={`tpl-body-${i}`} className="text-xs font-medium text-muted-foreground mb-1 block">
                            Parámetro {`{{${i + 1}}}`} del cuerpo
                          </label>
                          <Input id={`tpl-body-${i}`} value={tplBody[i] ?? ''}
                                 placeholder="Escribí un valor o usá el nombre del contacto"
                                 aria-describedby={`tpl-body-help-${i}`}
                                 onChange={e => {
                                   const v = e.target.value
                                   setTplBody(prev => { const next = [...prev]; next[i] = v; return next })
                                 }} />
                          <Button type="button" variant="outline" size="sm" className="mt-2"
                                  aria-label={`Usar nombre del contacto en {{${i + 1}}}`}
                                  onClick={() => setTplBody(prev => {
                                    const next = [...prev]; next[i] = CONTACT_NAME_VARIABLE; return next
                                  })}>
                            <UserCheck size={13} className="mr-1" /> Usar nombre del contacto
                          </Button>
                          <p id={`tpl-body-help-${i}`} className="text-xs text-muted-foreground mt-1">
                            {hasTemplateContactName(tplBody[i] ?? '')
                              ? 'Se reemplaza por el nombre guardado de cada contacto al enviar.'
                              : 'Un valor escrito sin llaves, como nombre o Pablo, se envía igual a todos.'}
                          </p>
                        </div>
                      ))}
                      {tplAnalysis.buttons.map(b => (
                        <div key={b.index}>
                          <label htmlFor={`tpl-button-${b.index}`} className="text-xs font-medium text-muted-foreground mb-1 block">
                            {b.sub_type === 'url'
                              ? `Valor variable de la URL del botón "${b.label}"`
                              : `Payload del botón "${b.label}" (opcional)`}
                          </label>
                          <Input id={`tpl-button-${b.index}`} value={tplButtons[b.index] ?? ''}
                                 onChange={e => {
                                   const v = e.target.value
                                   setTplButtons(prev => ({ ...prev, [b.index]: v }))
                                 }} />
                        </div>
                      ))}
                      {tplAnalysis.bodyCount === 0 && !tplAnalysis.header && tplAnalysis.buttons.length === 0 && (
                        <p className="text-xs text-muted-foreground">Esta plantilla no requiere parámetros.</p>
                      )}
                      <div className="bg-background rounded-lg p-3">
                        <p className="text-xs font-medium text-muted-foreground mb-1">Vista previa del cuerpo (WhatsApp la arma al enviar)</p>
                        <p className="text-sm text-foreground whitespace-pre-wrap">{fillTemplatePreview(tplAnalysis.bodyText, tplBody)}</p>
                        {tplBody.some(hasTemplateContactName) && (
                          <p className="text-xs text-muted-foreground mt-1">Pablo es un nombre de ejemplo. Cada contacto recibe el suyo.</p>
                        )}
                        {tplBuild && tplBuild.missing.length > 0 && (
                          <p className="text-xs text-orange-600 mt-1">Falta completar: {tplBuild.missing.join(', ')}</p>
                        )}
                        {tplBuild && tplBuild.invalid.length > 0 && (
                          <p className="text-xs text-destructive mt-1">Corregí: {tplBuild.invalid.join(', ')}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="col-span-2">
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Tipo de campaña</label>
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
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Tipo de audiencia</label>
              <div className="flex gap-2 mb-2">
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, audience_type: 'contacts', prospect_list_id: '' }))}
                  className={`flex-1 py-1.5 text-xs rounded-md border transition-colors font-medium ${
                    form.audience_type === 'contacts'
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-border text-muted-foreground hover:border-input'
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
                      : 'border-border text-muted-foreground hover:border-input'
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
                  {lists.length === 0 && !lookupFailures.includes('listas de contactos') && <p className="text-xs text-orange-500 mt-1">Creá primero una lista en Contactos</p>}
                </>
              ) : (
                <>
                  <Select value={form.prospect_list_id} onValueChange={v => setForm(f=>({...f,prospect_list_id:v ?? ''}))}>
                    <SelectTrigger><SelectValue placeholder="Seleccioná una lista de difusión" /></SelectTrigger>
                    <SelectContent>
                      {prospectLists.map(l => <SelectItem key={l.id} value={l.id}>{l.name} ({l.member_count.toLocaleString()} prospectos)</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {prospectLists.length === 0 && !lookupFailures.includes('listas de difusión') && <p className="text-xs text-orange-500 mt-1">Creá primero una lista en Contactos › Listas de Difusión</p>}
                </>
              )}
              {lookupFailures.length > 0 && (
                <p role="alert" className="text-xs text-destructive mt-1">
                  No se pudieron cargar: {lookupFailures.join(', ')}.{' '}
                  <button type="button" onClick={loadLookups} className="underline">Reintentar</button>
                </p>
              )}
            </div>

            <div>
              <label htmlFor="campaign-scheduled-at" className="text-xs font-medium text-muted-foreground mb-1 block">
                <Clock size={12} className="inline mr-1"/>Programar envío (opcional, hora Argentina UTC−03:00)
              </label>
              <Input
                id="campaign-scheduled-at"
                type="datetime-local"
                value={schedulerEnabled ? form.scheduled_at : ''}
                disabled={!schedulerEnabled}
                onChange={e => setForm(f=>({...f,scheduled_at:e.target.value}))}
              />
              {schedulerEnabled
                ? <p className="text-xs text-muted-foreground mt-1">Se interpreta como hora de Argentina (America/Argentina/Buenos_Aires).</p>
                : <p className="text-xs text-orange-500 mt-1">Programación automática no habilitada. Podés guardar la campaña como borrador y enviarla manualmente.</p>}
            </div>

            {/* Mensajes con variantes (sólo texto; las plantillas usan sus propios parámetros) */}
            {!useTemplate && <>
            <div className="col-span-2 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">
                  Mensajes{' '}
                  <span className="text-muted-foreground font-normal">(usá {'{{nombre}}'} para personalizar)</span>
                </label>
                <div className="flex items-center gap-2">
                  {messages.length > 1 && (
                    <span className="text-xs text-primary flex items-center gap-1">
                      <Shuffle size={11} /> Se envían aleatoriamente
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">{messages.length}/10</span>
                </div>
              </div>

              {messages.map((msg, i) => (
                <div key={i} className="relative group">
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-muted-foreground">
                          Variante {i + 1}
                          {messages.length > 1 && (
                            <button
                              type="button"
                              onClick={() => setPreviewIdx(i)}
                              className={`ml-2 text-xs underline ${previewIdx === i ? 'text-primary font-medium' : 'text-muted-foreground'}`}
                            >
                              {previewIdx === i ? 'previsualizando' : 'previsualizar'}
                            </button>
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground">{msg.length} car.</span>
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
                        className="mt-6 text-muted-foreground/60 hover:text-red-400 transition-colors"
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
                  className="w-full border-2 border-dashed border-border rounded-lg py-2 text-xs text-muted-foreground hover:border-indigo-300 hover:text-indigo-500 transition-colors flex items-center justify-center gap-1.5"
                >
                  <Plus size={13} /> Agregar variante de mensaje
                </button>
              )}
            </div>
            </>}

            <div className="col-span-2 rounded-lg border border-primary/20 bg-accent px-4 py-3 text-sm text-accent-foreground">
              <div className="flex items-center gap-2 font-medium"><GitBranch size={15} />Reparto automático entre líneas activas</div>
              <p className="mt-1 text-xs">Los clientes nuevos se reparten por turnos. Cada cliente conserva su línea en próximas campañas. Si no está disponible o no tiene cupo, queda pendiente.</p>
            </div>

            {!useTemplate && <>
            {/* Personalización de nombre */}
            <div className="col-span-2">
              <button
                type="button"
                onClick={() => setForm(f => ({ ...f, personalize_name: !f.personalize_name }))}
                className={`flex items-center gap-3 w-full rounded-lg border px-4 py-3 text-sm transition-colors ${
                  form.personalize_name
                    ? 'border-success/20 bg-success/10 text-success'
                    : 'border-border bg-background text-muted-foreground'
                }`}
              >
                <div className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${form.personalize_name ? 'bg-green-500' : 'bg-gray-300'}`}>
                  <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-card shadow transition-transform ${form.personalize_name ? 'translate-x-4' : ''}`} />
                </div>
                {form.personalize_name
                  ? <><UserCheck size={15} className="shrink-0" /><span>Nombre personalizado activado — <code className="bg-success/15 px-1 rounded">{'{{nombre}}'}</code> se reemplaza con el nombre de cada contacto</span></>
                  : <><UserX size={15} className="shrink-0" /><span>Nombre personalizado desactivado — <code className="bg-muted px-1 rounded">{'{{nombre}}'}</code> se omite del mensaje</span></>
                }
              </button>
            </div>

            {/* Preview */}
            {messages[previewIdx]?.trim() && (
              <div className="col-span-2 bg-background rounded-lg p-3">
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  Preview — Variante {previewIdx + 1}
                </p>
                <div className="inline-block bg-green-500 text-white text-sm px-3 py-2 rounded-2xl rounded-bl-sm max-w-xs">
                  {previewMsg}
                </div>
              </div>
            )}

            {/* Imagen adjunta */}
            <div className="col-span-2">
              <label className="text-xs font-medium text-muted-foreground mb-2 block flex items-center gap-1">
                <ImageIcon size={12} /> Imagen adjunta (opcional)
              </label>

              {form.media_url ? (
                <div className="relative w-full rounded-lg border border-border overflow-hidden bg-background flex items-center gap-3 p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={form.media_url}
                    alt="Media preview"
                    className="h-20 w-20 object-cover rounded-md border border-border shrink-0"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-muted-foreground truncate">{form.media_url}</p>
                    <p className="text-xs text-success mt-0.5">Imagen cargada correctamente</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setForm(f => ({ ...f, media_url: '' })); setUploadError(null) }}
                    className="p-1 rounded-full text-muted-foreground hover:text-red-500 hover:bg-destructive/10 transition-colors shrink-0"
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
                    className="w-full border-2 border-dashed border-border rounded-lg py-6 text-sm text-muted-foreground hover:border-indigo-300 hover:text-indigo-500 transition-colors flex flex-col items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {uploadingMedia
                      ? <><Loader2 size={20} className="animate-spin text-indigo-400" /><span>Subiendo imagen…</span></>
                      : <><Upload size={20} /><span>Hacé clic o arrastrá una imagen aquí</span><span className="text-xs text-muted-foreground/60">JPG, PNG, WEBP, GIF · máx. 10 MB</span></>
                    }
                  </button>
                  {/* También permitir pegar URL directamente */}
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-px flex-1 bg-muted" />
                    <span className="text-xs text-muted-foreground/60">o pegá una URL</span>
                    <div className="h-px flex-1 bg-muted" />
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
                <p className="text-xs text-destructive mt-1 flex items-center gap-1">
                  <AlertTriangle size={11} /> {uploadError}
                </p>
              )}
            </div>
            </>}

            {/* Pausas y límites: sólo antiblock_delay_min/max, que son los que usan los procesadores de envío */}
            <div className="col-span-2 border border-indigo-100 rounded-xl p-4 space-y-4 bg-indigo-50/30">
              <div className="flex items-center gap-2">
                <Shield size={14} className="text-indigo-500" />
                <span className="text-sm font-semibold text-foreground">Pausas y límites</span>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="campaign-delay-min" className="text-xs font-medium text-muted-foreground mb-1 block">Pausa mínima (segundos)</label>
                  <Input
                    id="campaign-delay-min"
                    type="number"
                    inputMode="numeric"
                    min={DELAY_MIN_SECONDS}
                    max={DELAY_MAX_SECONDS}
                    step={1}
                    className="bg-card"
                    value={form.antiblock_delay_min}
                    onChange={e => setForm(f => ({ ...f, antiblock_delay_min: Number(e.target.value) }))}
                  />
                </div>
                <div>
                  <label htmlFor="campaign-delay-max" className="text-xs font-medium text-muted-foreground mb-1 block">Pausa máxima (segundos)</label>
                  <Input
                    id="campaign-delay-max"
                    type="number"
                    inputMode="numeric"
                    min={DELAY_MIN_SECONDS}
                    max={DELAY_MAX_SECONDS}
                    step={1}
                    className="bg-card"
                    value={form.antiblock_delay_max}
                    onChange={e => setForm(f => ({ ...f, antiblock_delay_max: Number(e.target.value) }))}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Pausa aleatoria entre envíos, entre {DELAY_MIN_SECONDS} y {DELAY_MAX_SECONDS} segundos. Se respetan además los límites y horarios de cada línea.
                En modo multi-línea pueden añadirse pausas según la configuración de cada línea.
              </p>
            </div>

            {createError && (
              <div role="alert" className="col-span-2 bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2 text-sm text-destructive flex items-center justify-between">
                <span>{createError}</span>
                <button onClick={() => setCreateError(null)} className="ml-3 text-red-400 hover:text-destructive">✕</button>
              </div>
            )}
            <div className="col-span-2 flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setShowNew(false)} disabled={creating}>Cancelar</Button>
              <Button className="flex-1 bg-primary hover:bg-primary/90" onClick={createCampaign}
                      disabled={!canCreate}>
                {creating ? <Loader2 size={14} className="mr-1 animate-spin"/> : <Send size={14} className="mr-1"/>}
                {form.scheduled_at && schedulerEnabled ? 'Programar campaña' : 'Guardar campaña'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal detalle campaña */}
      <Dialog open={!!selected} onOpenChange={v => { if (!v) closeDetail() }}>
        <DialogContent className="w-[95vw] max-w-7xl sm:w-[95vw] sm:max-w-7xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selected?.name}
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[selected?.status || ''] || 'bg-muted text-muted-foreground'}`}>
                {STATUS_LABEL[selected?.status ?? ''] ?? selected?.status}
              </span>
            </DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4">
              {isAdmin && selected.message_type === 'template' && <CampaignTestSend key={selected.id} campaignId={selected.id} />}
              {/* Métricas */}
              <div className={`grid gap-3 text-center ${selected.total_skipped > 0 ? 'grid-cols-5' : 'grid-cols-4'}`}>
                <StatBox label="Enviados"    value={selected.total_sent}      color="blue"   />
                <StatBox label="Entregados"  value={selected.total_delivered} color="green"  />
                <StatBox label="Leídos"      value={selected.total_read}      color="purple" pct={selected.read_rate} />
                <StatBox label="Fallidos"    value={selected.total_failed}    color="red"    />
                {selected.total_skipped > 0 && (
                  <StatBox label="Omitidos" value={selected.total_skipped} color="orange" />
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
                <div className="border border-destructive/20 rounded-lg p-3 bg-destructive/10 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-destructive flex items-center gap-1.5">
                      <AlertTriangle size={14} /> {selected.total_failed} envío{selected.total_failed !== 1 ? 's' : ''} fallido{selected.total_failed !== 1 ? 's' : ''}
                    </p>
                    {!loadingContacts && campContacts.filter(c => c.msg_status === 'failed').length > 0 && (
                      <Button
                        size="sm" variant="outline"
                        className="border-red-300 text-destructive hover:bg-destructive/15 text-xs h-7 px-2 shrink-0"
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
                        if (failed.length === 0) return <p className="text-xs text-red-400">Sin detalle disponible aún — los datos se cargan al abrir el detalle.</p>
                        const grouped = failed.reduce<Record<string, number>>((acc, c) => {
                          const k = c.error_detail || 'sin detalle'
                          acc[k] = (acc[k] || 0) + 1
                          return acc
                        }, {})
                        return (
                          <div className="space-y-2">
                            {/* Resumen agrupado por error */}
                            <div className="space-y-1">
                              {Object.entries(grouped).sort((a,b) => b[1]-a[1]).map(([err, cnt], i) => (
                                <div key={i} className="flex items-start gap-2 text-xs bg-card border border-destructive/20 rounded px-2 py-1.5">
                                  <span className="shrink-0 font-bold text-red-500 min-w-[2rem]">{cnt}×</span>
                                  <span className="font-mono text-destructive break-all">{err}</span>
                                </div>
                              ))}
                            </div>
                            {/* Lista individual de contactos fallidos */}
                            <div className="space-y-1 pt-1 border-t border-destructive/20">
                              <p className="text-[11px] font-semibold text-destructive uppercase tracking-wide">Contactos fallidos</p>
                              <div className="max-h-40 overflow-y-auto space-y-1 pr-1">
                                {failed.map((c, i) => (
                                  <div key={c.id ?? i} className="flex items-center gap-2 text-xs bg-card border border-destructive/20 rounded px-2 py-1.5">
                                    <span className="font-mono text-muted-foreground shrink-0">{c.phone_number}</span>
                                    {(c.first_name || c.last_name) && (
                                      <span className="text-muted-foreground truncate">{[c.first_name, c.last_name].filter(Boolean).join(' ')}</span>
                                    )}
                                    {c.error_detail && (
                                      <span className="ml-auto text-red-500 font-mono text-[10px] truncate max-w-[140px]" title={c.error_detail}>{c.error_detail}</span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        )
                      })()
                  }
                  {failedListMsg && (
                    <p className={`text-xs pt-1 ${failedListMsg.startsWith('Error') ? 'text-destructive' : 'text-success font-medium'}`}>
                      {failedListMsg}
                    </p>
                  )}
                </div>
              )}

              {/* Mensajes */}
              {selected.message_type === 'template' ? (
                <div className="bg-background rounded-lg p-3 text-sm space-y-1">
                  <p className="font-medium text-foreground">Plantilla de WhatsApp{selected.template_name ? `: ${selected.template_name}` : ''}</p>
                  <p className="text-xs text-muted-foreground">El texto final lo arma WhatsApp con los parámetros de la campaña al enviar.</p>
                </div>
              ) : (
              <div className="bg-background rounded-lg p-3 text-sm space-y-2">
                <p className="font-medium text-foreground flex items-center gap-2">
                  Mensaje{Array.isArray(selected.messages) && selected.messages.length > 1 && (
                    <span className="text-xs bg-accent text-primary px-1.5 py-0.5 rounded-full flex items-center gap-1">
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
                      <span className="text-xs text-muted-foreground shrink-0 mt-0.5">#{i + 1}</span>
                    )}
                    <p className="text-muted-foreground">{msg}</p>
                  </div>
                ))}
              </div>
              )}

              <div className="text-xs text-muted-foreground space-y-1">
                {(selected.list_name || selected.prospect_list_name) && (
                  <p>Lista: <b className="text-muted-foreground">{selected.list_name || selected.prospect_list_name}</b></p>
                )}
                {selected.scheduled_at && (
                  <p>
                    Programado: {formatAR(selected.scheduled_at)}
                    {selected.status === 'scheduled' && !schedulerEnabled && ' — Programación automática no habilitada: requiere envío manual'}
                  </p>
                )}
                {selected.completed_at && <p>Completado: {formatAR(selected.completed_at)}</p>}
                <p>Antibloqueo: {selected.antiblock_delay_min}–{selected.antiblock_delay_max} seg entre mensajes</p>
                <p className="flex items-center gap-1">
                  {selected.personalize_name
                    ? <><UserCheck size={11} className="text-green-500"/> Nombre personalizado activado</>
                    : <><UserX size={11} className="text-muted-foreground"/> Nombre personalizado desactivado</>
                  }
                </p>
                <p className="flex items-center gap-1">
                  {selected.use_multi_line
                    ? <><GitBranch size={11} className="text-indigo-500"/> Modo multi-línea</>
                    : <><Zap size={11} className="text-muted-foreground"/> Envío individual</>
                  }
                </p>
              </div>

              {/* Dispatch progress — multi-line only */}
              {selected.use_multi_line && (
                <div className="border rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
                      <GitBranch size={14} className="text-indigo-500" /> Progreso de distribución
                    </p>
                    <button
                      className="text-xs text-muted-foreground hover:text-muted-foreground flex items-center gap-1"
                      disabled={loadingDispatch}
                      onClick={() => loadDispatch(selected.id, detailReqRef.current)}
                    >
                      <RefreshCw size={11} className={loadingDispatch ? 'animate-spin' : ''}/> Actualizar distribución
                    </button>
                  </div>
                  {dispatchError && (
                    <p role="alert" className="text-xs text-red-500">
                      {dispatchError}{dispatch ? ' Se muestran los últimos datos cargados.' : ''}
                    </p>
                  )}
                  {loadingDispatch && !dispatch
                    ? <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 size={12} className="animate-spin"/> Cargando…</p>
                    : dispatch
                    ? <>
                        <div className={`grid gap-2 text-center text-xs ${dispatch.skipped > 0 ? 'grid-cols-5' : 'grid-cols-4'}`}>
                          <div className="bg-background rounded p-2"><p className="font-bold text-foreground">{dispatch.total}</p><p className="text-muted-foreground">Total</p></div>
                          <div className="bg-yellow-50 rounded p-2"><p className="font-bold text-yellow-600">{dispatch.queued + dispatch.processing}</p><p className="text-muted-foreground">Pendiente</p></div>
                          <div className="bg-success/10 rounded p-2"><p className="font-bold text-success">{dispatch.sent}</p><p className="text-muted-foreground">Enviados</p></div>
                          <div className="bg-destructive/10 rounded p-2"><p className="font-bold text-red-500">{dispatch.failed}</p><p className="text-muted-foreground">Fallidos</p></div>
                          {dispatch.skipped > 0 && (
                            <div className="bg-orange-50 rounded p-2">
                              <p className="font-bold text-orange-500">{dispatch.skipped}</p>
                              <p className="text-muted-foreground">Omitidos</p>
                            </div>
                          )}
                        </div>
                        {dispatch.skipped > 0 && (
                          <div className="flex items-center justify-between gap-2 bg-orange-50 border border-orange-100 rounded px-2 py-1.5">
                            <p className="text-xs text-orange-600 flex items-center gap-1.5">
                              <Ban size={11}/> {dispatch.skipped} contacto{dispatch.skipped !== 1 ? 's fueron' : ' fue'} omitido{dispatch.skipped !== 1 ? 's' : ''} por límite de frecuencia (48h entre envíos).
                            </p>
                            {isAdmin && <button
                              className="text-xs text-orange-600 underline hover:text-orange-800 whitespace-nowrap flex items-center gap-1 disabled:opacity-50"
                              disabled={freqResetting === selected.id || !!selected.processor_locked_at || !['paused', 'completed', 'cancelled'].includes(selected.status)}
                              onClick={() => resetFreq(selected)}
                            >
                              {freqResetting === selected.id
                                ? <Loader2 size={11} className="animate-spin"/>
                                : <RefreshCw size={11}/>}
                              Reiniciar no enviados
                            </button>}
                          </div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {dispatch.eligible_lines} línea{dispatch.eligible_lines !== 1 ? 's' : ''} elegible{dispatch.eligible_lines !== 1 ? 's' : ''} ahora
                        </div>
                        {dispatch.line_usage.length > 0 && (
                          <div className="space-y-1">
                            <p className="text-xs font-medium text-muted-foreground">Uso por línea</p>
                            {dispatch.line_usage.map(lu => (
                              <div key={lu.line_id} className="flex items-center gap-2 text-xs">
                                <span className="text-muted-foreground truncate flex-1">{lu.display_name || lu.line_key}</span>
                                <span className="text-success">{lu.sent} env.</span>
                                {lu.failed > 0 && <span className="text-red-400">{lu.failed} err.</span>}
                              </div>
                            ))}
                          </div>
                        )}
                        {dispatch.top_errors && dispatch.top_errors.length > 0 && (
                          <div className="space-y-1">
                            <p className="text-xs font-medium text-destructive">Errores frecuentes</p>
                            {dispatch.top_errors.map((e, i) => (
                              <div key={i} className="flex items-start gap-2 text-xs bg-destructive/10 border border-destructive/20 rounded p-2">
                                <span className="shrink-0 font-bold text-red-500">{e.count}×</span>
                                <span className="text-destructive break-all font-mono">{e.error}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    : <p className="text-xs text-muted-foreground">Sin datos de distribución</p>
                  }
                </div>
              )}

              {/* Tabla de contactos */}
              <div>
                <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                  <p className="text-sm font-medium text-foreground">Destinatarios</p>
                  {!loadingContacts && campContacts.length > 0 && (
                    <div className="flex items-center gap-1 text-xs">
                      {[
                        { key: 'all',       label: 'Todos',      count: campContacts.length },
                        { key: 'failed',    label: 'Fallidos',   count: campContacts.filter(c => c.msg_status === 'failed').length },
                        { key: 'sent',      label: 'Enviados',   count: campContacts.filter(c => ['sent','delivered','read'].includes(c.msg_status ?? '')).length },
                        { key: 'pending',   label: 'Pendientes', count: campContacts.filter(c => ['pending','sending'].includes(c.msg_status ?? '')).length },
                      ].filter(t => t.count > 0 || t.key === 'all').map(t => (
                        <button
                          key={t.key}
                          onClick={() => setContactStatusFilter(t.key)}
                          className={`px-2 py-0.5 rounded-full border transition-colors ${
                            contactStatusFilter === t.key
                              ? t.key === 'failed'
                                ? 'bg-destructive/15 border-red-300 text-destructive font-semibold'
                                : 'bg-accent border-indigo-300 text-primary font-semibold'
                              : 'border-border text-muted-foreground hover:bg-background'
                          }`}
                        >
                          {t.label} {t.count > 0 && <span className="ml-0.5 opacity-70">{t.count}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {detailError
                  ? <p className="text-sm text-red-500 bg-destructive/10 border border-destructive/20 rounded px-3 py-2">{detailError}</p>
                  : loadingContacts
                  ? <div className="flex items-center gap-2 py-4 text-muted-foreground text-sm"><Loader2 size={14} className="animate-spin"/> Cargando…</div>
                  : campContacts.length === 0
                    ? <p className="text-sm text-muted-foreground">Sin contactos registrados</p>
                    : (() => {
                        const filtered = contactStatusFilter === 'all'
                          ? campContacts
                          : contactStatusFilter === 'failed'
                            ? campContacts.filter(c => c.msg_status === 'failed')
                            : contactStatusFilter === 'sent'
                              ? campContacts.filter(c => ['sent','delivered','read'].includes(c.msg_status ?? ''))
                              : campContacts.filter(c => ['pending','sending'].includes(c.msg_status ?? ''))
                        return (
                          <div className="border rounded-lg overflow-hidden">
                            <table className="w-full text-sm">
                              <thead className="bg-background border-b border-border">
                                <tr>
                                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Contacto</th>
                                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Teléfono</th>
                                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Estado</th>
                                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Enviado</th>
                                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">Leído</th>
                                </tr>
                              </thead>
                              <tbody>
                                {filtered.map(c => (
                                  <tr key={c.id} className={`border-b border-border last:border-0 hover:bg-background ${c.msg_status === 'failed' ? 'bg-red-50/40' : ''}`}>
                                    <td className="px-3 py-2">
                                      {[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}
                                    </td>
                                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{c.phone_number}</td>
                                    <td className="px-3 py-2">
                                      <ContactStatusBadge status={c.msg_status} />
                                      {c.msg_status === 'failed' && c.error_detail && (
                                        <p className="text-xs text-red-500 font-mono mt-0.5 break-all max-w-xs">{c.error_detail}</p>
                                      )}
                                    </td>
                                    <td className="px-3 py-2 text-xs text-muted-foreground">
                                      {c.sent_at ? new Date(c.sent_at).toLocaleString('es-AR', { dateStyle:'short', timeStyle:'short' }) : '—'}
                                    </td>
                                    <td className="px-3 py-2 text-xs text-muted-foreground">
                                      {c.read_at ? new Date(c.read_at).toLocaleString('es-AR', { dateStyle:'short', timeStyle:'short' }) : '—'}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )
                      })()
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
  const colors: Record<string, string> = { blue:'text-blue-600', green:'text-success', purple:'text-purple-600', red:'text-red-500', orange:'text-orange-500' }
  return (
    <div>
      <p className={`text-lg font-bold ${colors[color]}`}>{value}{pct !== undefined ? <span className="text-xs font-normal ml-0.5">{pct}%</span> : ''}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

function StatBox({ label, value, color, pct }: { label: string; value: number; color: string; pct?: number }) {
  const colors: Record<string, string> = { blue:'text-blue-600 bg-blue-50', green:'text-success bg-success/10', purple:'text-purple-600 bg-purple-50', red:'text-red-500 bg-destructive/10', orange:'text-orange-500 bg-orange-50' }
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
      <div className="flex justify-between text-xs text-muted-foreground mb-1"><span>{label}</span><span>{value}%</span></div>
      <div className="w-full bg-muted rounded-full h-2">
        <div className={`${colors[color]} h-2 rounded-full transition-all`} style={{ width: `${Math.min(value,100)}%` }} />
      </div>
    </div>
  )
}

function ContactStatusBadge({ status }: { status: string | null }) {
  if (!status) return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <HelpCircle size={12}/> Sin enviar
    </span>
  )
  const map: Record<string, { label: string; className: string; icon: React.ReactNode }> = {
    read:      { label: 'Leído',      className: 'text-purple-600', icon: <CheckCheck size={12}/> },
    delivered: { label: 'Entregado',  className: 'text-success',  icon: <Truck size={12}/> },
    sent:      { label: 'Enviado',    className: 'text-blue-500',   icon: <Send size={12}/> },
    failed:    { label: 'Fallido',    className: 'text-red-500',    icon: <AlertTriangle size={12}/> },
    skipped:   { label: 'Omitido (freq.)', className: 'text-orange-500', icon: <Ban size={12}/> },
    sending:   { label: 'Enviando…',  className: 'text-yellow-600', icon: <Loader2 size={12} className="animate-spin"/> },
    pending:   { label: 'En cola',    className: 'text-muted-foreground',   icon: <Clock size={12}/> },
  }
  const s = map[status] || { label: status, className: 'text-muted-foreground', icon: <HelpCircle size={12}/> }
  return (
    <span className={`flex items-center gap-1 text-xs font-medium ${s.className}`}>
      {s.icon} {s.label}
    </span>
  )
}
