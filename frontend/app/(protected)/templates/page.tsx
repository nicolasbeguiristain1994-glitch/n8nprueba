'use client'
import { useEffect, useState, useCallback } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  Plus, Pencil, Copy, Trash2, Send, RefreshCw, Loader2,
  AlertCircle, Eye, FileText, Image, Video, File,
  Phone, ExternalLink, MessageSquare,
} from 'lucide-react'
import { useCurrentUser } from '@/lib/useCurrentUser'

// ── Tipos ─────────────────────────────────────────────────────────────────────

type TemplateStatus = 'BORRADOR' | 'EN_REVISION' | 'APROBADA' | 'RECHAZADA' | 'DESHABILITADA'
type TemplateCategory = 'UTILITY' | 'MARKETING' | 'AUTHENTICATION'

type HeaderComponent = { type: 'HEADER' } & (
  | { format: 'TEXT'; text: string }
  | { format: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; example?: string }
)
type BodyComponent    = { type: 'BODY'; text: string }
type FooterComponent  = { type: 'FOOTER'; text: string }
type ButtonComponent  = { type: 'BUTTONS'; buttons: TemplateButton[] }
type TemplateButton   =
  | { type: 'QUICK_REPLY'; text: string }
  | { type: 'URL'; text: string; url: string }
  | { type: 'PHONE_NUMBER'; text: string; phone_number: string }

type TemplateComponent = HeaderComponent | BodyComponent | FooterComponent | ButtonComponent

interface Template {
  id: string
  name: string
  category: TemplateCategory
  language: string
  status: TemplateStatus
  components: TemplateComponent[]
  whatsapp_template_id: string | null
  rejection_reason: string | null
  usage_count: number
  last_used_at: string | null
  created_at: string
  updated_at: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<TemplateStatus, string> = {
  BORRADOR:      'Borrador',
  EN_REVISION:   'En revisión',
  APROBADA:      'Aprobada',
  RECHAZADA:     'Rechazada',
  DESHABILITADA: 'Deshabilitada',
}

const STATUS_STYLE: Record<TemplateStatus, string> = {
  BORRADOR:      'bg-gray-100 text-gray-600',
  EN_REVISION:   'bg-yellow-100 text-yellow-700',
  APROBADA:      'bg-green-100 text-green-700',
  RECHAZADA:     'bg-red-100 text-red-700',
  DESHABILITADA: 'bg-slate-100 text-slate-500',
}

const CATEGORY_LABEL: Record<TemplateCategory, string> = {
  UTILITY:        'Utilidad',
  MARKETING:      'Marketing',
  AUTHENTICATION: 'Autenticación',
}

const LANGUAGES = [
  { value: 'es',    label: 'Español' },
  { value: 'en',    label: 'Inglés' },
  { value: 'pt_BR', label: 'Portugués (BR)' },
  { value: 'pt',    label: 'Portugués' },
  { value: 'fr',    label: 'Francés' },
  { value: 'de',    label: 'Alemán' },
  { value: 'ar',    label: 'Árabe' },
]

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

// Resalta variables {{N}} en el texto del body
function highlightVars(text: string) {
  const parts = text.split(/({{[0-9]+}})/)
  return parts.map((p, i) =>
    /^{{[0-9]+}}$/.test(p)
      ? <span key={i} className="bg-blue-100 text-blue-700 rounded px-0.5 font-mono text-xs">{p}</span>
      : <span key={i}>{p}</span>
  )
}

// ── Preview WhatsApp ──────────────────────────────────────────────────────────

function WhatsAppPreview({ components }: { components: TemplateComponent[] }) {
  const header  = components.find((c): c is HeaderComponent => c.type === 'HEADER')
  const body    = components.find((c): c is BodyComponent   => c.type === 'BODY')
  const footer  = components.find((c): c is FooterComponent => c.type === 'FOOTER')
  const buttons = components.find((c): c is ButtonComponent => c.type === 'BUTTONS')

  return (
    <div className="bg-[#e5ddd5] rounded-xl p-4 min-h-48 flex flex-col items-start">
      <div className="bg-white rounded-xl shadow-sm max-w-[85%] overflow-hidden">
        {/* Header */}
        {header && (
          <div className="bg-[#d9fdd3] px-3 pt-3 pb-1">
            {header.format === 'TEXT' && (
              <p className="font-semibold text-sm text-gray-800 whitespace-pre-line">
                {header.text || <span className="text-gray-400 italic">Encabezado</span>}
              </p>
            )}
            {header.format === 'IMAGE' && (
              <div className="w-full h-28 bg-gray-200 rounded-lg flex items-center justify-center">
                <Image size={28} className="text-gray-400" />
                <span className="text-xs text-gray-400 ml-2">Imagen</span>
              </div>
            )}
            {header.format === 'VIDEO' && (
              <div className="w-full h-28 bg-gray-200 rounded-lg flex items-center justify-center">
                <Video size={28} className="text-gray-400" />
                <span className="text-xs text-gray-400 ml-2">Video</span>
              </div>
            )}
            {header.format === 'DOCUMENT' && (
              <div className="w-full h-16 bg-gray-100 rounded-lg flex items-center px-3 gap-2">
                <File size={24} className="text-gray-500" />
                <span className="text-xs text-gray-500">Documento adjunto</span>
              </div>
            )}
          </div>
        )}
        {/* Body */}
        <div className={`px-3 py-2 ${header ? '' : 'pt-3'} bg-[#d9fdd3]`}>
          {body ? (
            <p className="text-sm text-gray-800 whitespace-pre-line leading-relaxed">
              {highlightVars(body.text || '')}
            </p>
          ) : (
            <p className="text-sm text-gray-400 italic">Escribe el cuerpo del mensaje…</p>
          )}
        </div>
        {/* Footer */}
        {footer && footer.text && (
          <div className="px-3 pb-2 bg-[#d9fdd3]">
            <p className="text-xs text-gray-400 mt-1">{footer.text}</p>
          </div>
        )}
        {/* Timestamp */}
        <div className="px-3 pb-2 bg-[#d9fdd3] flex justify-end">
          <span className="text-[10px] text-gray-400">12:00 ✓✓</span>
        </div>
        {/* Buttons */}
        {buttons && buttons.buttons.length > 0 && (
          <div className="border-t border-gray-200">
            {buttons.buttons.map((btn, i) => (
              <button key={i} className="w-full py-2 px-3 text-sm text-[#00a5f4] flex items-center justify-center gap-1.5 border-b border-gray-100 last:border-0 hover:bg-gray-50">
                {btn.type === 'PHONE_NUMBER' && <Phone size={13} />}
                {btn.type === 'URL'          && <ExternalLink size={13} />}
                {btn.type === 'QUICK_REPLY'  && <MessageSquare size={13} />}
                {btn.text || <span className="text-gray-300 italic text-xs">Botón</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Formulario ────────────────────────────────────────────────────────────────

interface FormState {
  name: string
  category: TemplateCategory
  language: string
  headerEnabled: boolean
  headerFormat: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT'
  headerText: string
  bodyText: string
  footerEnabled: boolean
  footerText: string
  buttonsEnabled: boolean
  buttons: TemplateButton[]
}

const DEFAULT_FORM: FormState = {
  name: '', category: 'MARKETING', language: 'es',
  headerEnabled: false, headerFormat: 'TEXT', headerText: '',
  bodyText: '',
  footerEnabled: false, footerText: '',
  buttonsEnabled: false, buttons: [],
}

function formToComponents(f: FormState): TemplateComponent[] {
  const comps: TemplateComponent[] = []
  if (f.headerEnabled) {
    if (f.headerFormat === 'TEXT') {
      comps.push({ type: 'HEADER', format: 'TEXT', text: f.headerText })
    } else {
      comps.push({ type: 'HEADER', format: f.headerFormat })
    }
  }
  comps.push({ type: 'BODY', text: f.bodyText })
  if (f.footerEnabled && f.footerText) {
    comps.push({ type: 'FOOTER', text: f.footerText })
  }
  if (f.buttonsEnabled && f.buttons.length > 0) {
    comps.push({ type: 'BUTTONS', buttons: f.buttons })
  }
  return comps
}

function templateToForm(t: Template): FormState {
  const header  = t.components.find((c): c is HeaderComponent => c.type === 'HEADER')
  const body    = t.components.find((c): c is BodyComponent   => c.type === 'BODY')
  const footer  = t.components.find((c): c is FooterComponent => c.type === 'FOOTER')
  const buttons = t.components.find((c): c is ButtonComponent => c.type === 'BUTTONS')
  return {
    name:           t.name,
    category:       t.category,
    language:       t.language,
    headerEnabled:  !!header,
    headerFormat:   header?.format ?? 'TEXT',
    headerText:     header?.format === 'TEXT' ? header.text : '',
    bodyText:       body?.text ?? '',
    footerEnabled:  !!footer,
    footerText:     footer?.text ?? '',
    buttonsEnabled: !!buttons,
    buttons:        buttons?.buttons ?? [],
  }
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function TemplatesPage() {
  const { user } = useCurrentUser()
  const isAdmin  = user?.role === 'admin'

  const [templates, setTemplates] = useState<Template[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)

  // Filtros
  const [filterStatus,   setFilterStatus]   = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [filterQ,        setFilterQ]        = useState('')

  // Modal
  const [modal,      setModal]      = useState<'create' | 'edit' | null>(null)
  const [editTarget, setEditTarget] = useState<Template | null>(null)
  const [form,       setForm]       = useState<FormState>(DEFAULT_FORM)
  const [saving,     setSaving]     = useState(false)
  const [saveError,  setSaveError]  = useState<string | null>(null)

  // Acciones de fila
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [syncing,    setSyncing]    = useState<string | null>(null)
  const [deleting,   setDeleting]   = useState<string | null>(null)
  const [rowError,   setRowError]   = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    if (filterStatus)   params.set('status',   filterStatus)
    if (filterCategory) params.set('category', filterCategory)
    if (filterQ)        params.set('q',        filterQ)
    try {
      const res  = await fetch(`/api/templates?${params.toString()}`)
      const data = await res.json() as { templates?: Template[]; error?: string }
      if (!res.ok) { setError(data.error || `Error ${res.status}`); return }
      setTemplates(data.templates ?? [])
    } catch { setError('Error de red') } finally { setLoading(false) }
  }, [filterStatus, filterCategory, filterQ])

  useEffect(() => { void load() }, [load])

  function openCreate() {
    setForm(DEFAULT_FORM)
    setEditTarget(null)
    setSaveError(null)
    setModal('create')
  }

  function openEdit(t: Template) {
    setForm(templateToForm(t))
    setEditTarget(t)
    setSaveError(null)
    setModal('edit')
  }

  function openDuplicate(t: Template) {
    const f = templateToForm(t)
    f.name = `${t.name}_copia`
    setForm(f)
    setEditTarget(null)
    setSaveError(null)
    setModal('create')
  }

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    const payload = {
      name:       form.name,
      category:   form.category,
      language:   form.language,
      components: formToComponents(form),
    }
    if (!payload.name.trim()) { setSaveError('El nombre es requerido'); setSaving(false); return }
    if (!payload.components.some(c => c.type === 'BODY') || !form.bodyText.trim()) {
      setSaveError('El cuerpo del mensaje es requerido'); setSaving(false); return
    }
    try {
      const url    = modal === 'edit' && editTarget ? `/api/templates/${editTarget.id}` : '/api/templates'
      const method = modal === 'edit' ? 'PATCH' : 'POST'
      const res    = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const data   = await res.json() as { error?: string }
      if (!res.ok) { setSaveError(data.error || `Error ${res.status}`); return }
      setModal(null)
      void load()
    } catch { setSaveError('Error de red') } finally { setSaving(false) }
  }

  async function handleDelete(id: string) {
    if (!confirm('¿Eliminar esta plantilla? Esta acción no se puede deshacer.')) return
    setDeleting(id); setRowError(null)
    try {
      const res  = await fetch(`/api/templates/${id}`, { method: 'DELETE' })
      const data = await res.json() as { error?: string }
      if (!res.ok) { setRowError(data.error || `Error ${res.status}`); return }
      void load()
    } catch { setRowError('Error de red') } finally { setDeleting(null) }
  }

  async function handleSubmit(id: string) {
    setSubmitting(id); setRowError(null)
    try {
      const res  = await fetch(`/api/templates/${id}/submit`, { method: 'POST' })
      const data = await res.json() as { error?: string; status?: string }
      if (!res.ok) { setRowError(data.error || `Error ${res.status}`); return }
      void load()
    } catch { setRowError('Error de red') } finally { setSubmitting(null) }
  }

  async function handleSync(id: string) {
    setSyncing(id); setRowError(null)
    try {
      const res  = await fetch(`/api/templates/${id}/sync`, { method: 'POST' })
      const data = await res.json() as { error?: string }
      if (!res.ok) { setRowError(data.error || `Error ${res.status}`); return }
      void load()
    } catch { setRowError('Error de red') } finally { setSyncing(null) }
  }

  function updateButton(idx: number, patch: Partial<TemplateButton>) {
    setForm(f => {
      const btns = [...f.buttons]
      btns[idx] = { ...btns[idx], ...patch } as TemplateButton
      return { ...f, buttons: btns }
    })
  }

  function addButton() {
    if (form.buttons.length >= 3) return
    setForm(f => ({ ...f, buttons: [...f.buttons, { type: 'QUICK_REPLY', text: '' }] }))
  }

  function removeButton(idx: number) {
    setForm(f => ({ ...f, buttons: f.buttons.filter((_, i) => i !== idx) }))
  }

  const previewComponents = formToComponents(form)

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Plantillas</h1>
          <p className="text-sm text-gray-500 mt-0.5">Plantillas de mensajes de WhatsApp Business</p>
        </div>
        {isAdmin && (
          <Button onClick={openCreate} className="h-9 text-sm gap-2">
            <Plus size={15} /> Nueva plantilla
          </Button>
        )}
      </div>

      {/* Filtros */}
      <div className="flex gap-2 flex-wrap">
        <Input
          placeholder="Buscar por nombre…"
          value={filterQ}
          onChange={e => setFilterQ(e.target.value)}
          className="h-8 text-sm w-52"
        />
        <Select value={filterStatus || 'all'} onValueChange={v => setFilterStatus((v ?? '') === 'all' ? '' : (v ?? ''))}>
          <SelectTrigger className="h-8 text-sm w-40"><SelectValue placeholder="Estado" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los estados</SelectItem>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filterCategory || 'all'} onValueChange={v => setFilterCategory((v ?? '') === 'all' ? '' : (v ?? ''))}>
          <SelectTrigger className="h-8 text-sm w-44"><SelectValue placeholder="Categoría" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas las categorías</SelectItem>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" onClick={() => void load()} className="h-8 text-sm">
          <RefreshCw size={13} className="mr-1" /> Actualizar
        </Button>
      </div>

      {/* Error de fila */}
      {rowError && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          <AlertCircle size={15} className="shrink-0" /> {rowError}
          <button onClick={() => setRowError(null)} className="ml-auto text-red-400 hover:text-red-600">✕</button>
        </div>
      )}

      {/* Tabla */}
      {loading ? (
        <div className="flex items-center justify-center h-40">
          <Loader2 size={22} className="animate-spin text-gray-300" />
        </div>
      ) : error ? (
        <div className="text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3 flex items-center gap-2">
          <AlertCircle size={15} /> {error}
        </div>
      ) : templates.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <FileText size={36} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">No hay plantillas{filterStatus || filterCategory || filterQ ? ' con esos filtros' : ' todavía'}</p>
          {isAdmin && !filterStatus && !filterCategory && !filterQ && (
            <Button variant="ghost" size="sm" onClick={openCreate} className="mt-3 text-sm text-green-600">
              <Plus size={14} className="mr-1" /> Crear primera plantilla
            </Button>
          )}
        </div>
      ) : (
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Nombre</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Categoría</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Idioma</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Estado</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Usos</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Actualizada</th>
                {isAdmin && <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Acciones</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {templates.map(t => (
                <tr key={t.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <div>
                      <p className="font-medium text-gray-900 font-mono text-xs">{t.name}</p>
                      {t.rejection_reason && (
                        <p className="text-xs text-red-500 mt-0.5 max-w-xs truncate" title={t.rejection_reason}>
                          ↳ {t.rejection_reason}
                        </p>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{CATEGORY_LABEL[t.category as TemplateCategory]}</td>
                  <td className="px-4 py-3 text-gray-500 uppercase text-xs">{t.language}</td>
                  <td className="px-4 py-3">
                    <Badge className={STATUS_STYLE[t.status as TemplateStatus]}>
                      {STATUS_LABEL[t.status as TemplateStatus]}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{t.usage_count}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{fmtDate(t.updated_at)}</td>
                  {isAdmin && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <button onClick={() => openEdit(t)} title="Editar" className="p-1.5 rounded hover:bg-gray-100 text-gray-500">
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => openDuplicate(t)} title="Duplicar" className="p-1.5 rounded hover:bg-gray-100 text-gray-500">
                          <Copy size={14} />
                        </button>
                        {(t.status === 'BORRADOR' || t.status === 'RECHAZADA') && (
                          <button
                            onClick={() => void handleSubmit(t.id)}
                            disabled={submitting === t.id}
                            title="Enviar a revisión de Meta"
                            className="p-1.5 rounded hover:bg-blue-50 text-blue-500 disabled:opacity-50"
                          >
                            {submitting === t.id ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                          </button>
                        )}
                        {t.whatsapp_template_id && (
                          <button
                            onClick={() => void handleSync(t.id)}
                            disabled={syncing === t.id}
                            title="Actualizar estado desde Meta"
                            className="p-1.5 rounded hover:bg-gray-100 text-gray-400 disabled:opacity-50"
                          >
                            {syncing === t.id ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                          </button>
                        )}
                        <button
                          onClick={() => void handleDelete(t.id)}
                          disabled={deleting === t.id}
                          title="Eliminar"
                          className="p-1.5 rounded hover:bg-red-50 text-red-400 disabled:opacity-50"
                        >
                          {deleting === t.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal crear/editar */}
      <Dialog open={modal !== null} onOpenChange={open => { if (!open) setModal(null) }}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{modal === 'edit' ? 'Editar plantilla' : 'Nueva plantilla'}</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-6 mt-2">
            {/* Columna izquierda — formulario */}
            <div className="space-y-4">
              {/* Nombre */}
              <div>
                <label className="text-sm font-medium text-gray-700 block mb-1">
                  Nombre <span className="text-red-500">*</span>
                </label>
                <Input
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="ej: bienvenida_nuevos"
                  className="h-9 text-sm font-mono"
                />
                <p className="text-xs text-gray-400 mt-1">Recomendado: snake_case. Se convertirá automáticamente.</p>
              </div>

              {/* Categoría + Idioma */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium text-gray-700 block mb-1">
                    Categoría <span className="text-red-500">*</span>
                  </label>
                  <Select value={form.category} onValueChange={v => setForm(f => ({ ...f, category: v as TemplateCategory }))}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MARKETING">Marketing</SelectItem>
                      <SelectItem value="UTILITY">Utilidad</SelectItem>
                      <SelectItem value="AUTHENTICATION">Autenticación</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700 block mb-1">
                    Idioma <span className="text-red-500">*</span>
                  </label>
                  <Select value={form.language} onValueChange={v => setForm(f => ({ ...f, language: v ?? f.language }))}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LANGUAGES.map(l => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <hr className="border-gray-100" />

              {/* Header */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer mb-2">
                  <input type="checkbox" className="w-4 h-4 accent-green-600"
                    checked={form.headerEnabled}
                    onChange={e => setForm(f => ({ ...f, headerEnabled: e.target.checked }))} />
                  <span className="text-sm font-medium text-gray-700">Encabezado (Header)</span>
                </label>
                {form.headerEnabled && (
                  <div className="space-y-2 pl-6">
                    <Select value={form.headerFormat} onValueChange={v => setForm(f => ({ ...f, headerFormat: v as FormState['headerFormat'] }))}>
                      <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="TEXT">Texto</SelectItem>
                        <SelectItem value="IMAGE">Imagen</SelectItem>
                        <SelectItem value="VIDEO">Video</SelectItem>
                        <SelectItem value="DOCUMENT">Documento</SelectItem>
                      </SelectContent>
                    </Select>
                    {form.headerFormat === 'TEXT' && (
                      <Input
                        value={form.headerText}
                        onChange={e => setForm(f => ({ ...f, headerText: e.target.value }))}
                        placeholder="Texto del encabezado (máx. 60 caracteres)"
                        maxLength={60}
                        className="h-8 text-sm"
                      />
                    )}
                  </div>
                )}
              </div>

              {/* Body */}
              <div>
                <label className="text-sm font-medium text-gray-700 block mb-1">
                  Cuerpo del mensaje <span className="text-red-500">*</span>
                </label>
                <Textarea
                  value={form.bodyText}
                  onChange={e => setForm(f => ({ ...f, bodyText: e.target.value }))}
                  placeholder="Escribe el mensaje. Usa {{1}}, {{2}}, etc. para variables."
                  rows={5}
                  maxLength={1024}
                  className="text-sm resize-none"
                />
                <p className="text-xs text-gray-400 mt-1">
                  {form.bodyText.length}/1024 caracteres. Variables:{' '}
                  <code className="bg-gray-100 px-1 rounded">{'{{1}}'}</code>,{' '}
                  <code className="bg-gray-100 px-1 rounded">{'{{2}}'}</code>…
                </p>
              </div>

              {/* Footer */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer mb-2">
                  <input type="checkbox" className="w-4 h-4 accent-green-600"
                    checked={form.footerEnabled}
                    onChange={e => setForm(f => ({ ...f, footerEnabled: e.target.checked }))} />
                  <span className="text-sm font-medium text-gray-700">Pie de página (Footer)</span>
                </label>
                {form.footerEnabled && (
                  <Input
                    value={form.footerText}
                    onChange={e => setForm(f => ({ ...f, footerText: e.target.value }))}
                    placeholder="Texto del pie de página (máx. 60 caracteres)"
                    maxLength={60}
                    className="h-8 text-sm ml-6"
                  />
                )}
              </div>

              {/* Buttons */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer mb-2">
                  <input type="checkbox" className="w-4 h-4 accent-green-600"
                    checked={form.buttonsEnabled}
                    onChange={e => setForm(f => ({
                      ...f,
                      buttonsEnabled: e.target.checked,
                      buttons: e.target.checked && f.buttons.length === 0
                        ? [{ type: 'QUICK_REPLY', text: '' }]
                        : f.buttons,
                    }))} />
                  <span className="text-sm font-medium text-gray-700">Botones (máx. 3)</span>
                </label>
                {form.buttonsEnabled && (
                  <div className="space-y-2 pl-6">
                    {form.buttons.map((btn, i) => (
                      <div key={i} className="border border-gray-200 rounded-lg p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <Select value={btn.type} onValueChange={v => updateButton(i, { type: v as TemplateButton['type'] })}>
                            <SelectTrigger className="h-7 text-xs flex-1"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="QUICK_REPLY">Respuesta rápida</SelectItem>
                              <SelectItem value="URL">URL</SelectItem>
                              <SelectItem value="PHONE_NUMBER">Teléfono</SelectItem>
                            </SelectContent>
                          </Select>
                          <button onClick={() => removeButton(i)} className="p-1 hover:bg-red-50 text-red-400 rounded">
                            <Trash2 size={13} />
                          </button>
                        </div>
                        <Input
                          value={btn.text}
                          onChange={e => updateButton(i, { text: e.target.value })}
                          placeholder="Texto del botón"
                          className="h-7 text-xs"
                          maxLength={20}
                        />
                        {btn.type === 'URL' && (
                          <Input
                            value={(btn as { url?: string }).url || ''}
                            onChange={e => updateButton(i, { url: e.target.value })}
                            placeholder="https://..."
                            className="h-7 text-xs"
                          />
                        )}
                        {btn.type === 'PHONE_NUMBER' && (
                          <Input
                            value={(btn as { phone_number?: string }).phone_number || ''}
                            onChange={e => updateButton(i, { phone_number: e.target.value })}
                            placeholder="+5491112345678"
                            className="h-7 text-xs"
                          />
                        )}
                      </div>
                    ))}
                    {form.buttons.length < 3 && (
                      <button onClick={addButton} className="text-xs text-green-600 hover:text-green-700 flex items-center gap-1">
                        <Plus size={12} /> Agregar botón
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Columna derecha — preview */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Eye size={14} className="text-gray-400" />
                <p className="text-sm font-medium text-gray-600">Vista previa en tiempo real</p>
              </div>
              <WhatsAppPreview components={previewComponents} />
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <p className="text-xs text-amber-700">
                  La aprobación de Meta puede tardar entre minutos y varias horas.
                </p>
              </div>
            </div>
          </div>

          {/* Footer del modal */}
          {saveError && (
            <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2 mt-4">
              <AlertCircle size={14} /> {saveError}
            </div>
          )}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-gray-100 mt-4">
            <Button variant="ghost" onClick={() => setModal(null)} className="h-9 text-sm">Cancelar</Button>
            <Button onClick={() => void handleSave()} disabled={saving} className="h-9 text-sm">
              {saving
                ? <><Loader2 size={13} className="animate-spin mr-1" />Guardando…</>
                : 'Guardar plantilla'
              }
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
