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
import {
  TEMPLATE_BUTTON_TEXT_MAX, TEMPLATE_NAME_MAX,
  analyzeBodyVariables, buildBodyComponent, collectTemplateErrors, normalizeTemplateName,
  readBodyExamples, validateTemplateDraft, type TemplateIssue,
} from '@/lib/template-validation'

// ── Tipos ─────────────────────────────────────────────────────────────────────

type TemplateStatus = 'BORRADOR' | 'EN_REVISION' | 'APROBADA' | 'RECHAZADA' | 'DESHABILITADA'
type TemplateCategory = 'UTILITY' | 'MARKETING' | 'AUTHENTICATION'

type HeaderComponent = { type: 'HEADER' } & (
  | { format: 'TEXT'; text: string }
  | { format: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; example?: string }
)
type BodyComponent    = { type: 'BODY'; text: string; example?: { body_text: string[][] } }
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
  BORRADOR:      'bg-muted text-muted-foreground',
  EN_REVISION:   'bg-yellow-100 text-yellow-700',
  APROBADA:      'bg-success/15 text-success',
  RECHAZADA:     'bg-destructive/15 text-destructive',
  DESHABILITADA: 'bg-muted text-slate-500',
}

const CATEGORY_LABEL: Record<TemplateCategory, string> = {
  UTILITY:        'Utilidad',
  MARKETING:      'Marketing',
  AUTHENTICATION: 'Autenticación',
}

const LANGUAGES = [
  { value: 'es',    label: 'Español' },
  { value: 'es_AR', label: 'Español (Argentina)' },
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
      <div className="bg-card rounded-xl shadow-sm max-w-[85%] overflow-hidden">
        {/* Header */}
        {header && (
          <div className="bg-[#d9fdd3] px-3 pt-3 pb-1">
            {header.format === 'TEXT' && (
              <p className="font-semibold text-sm text-foreground whitespace-pre-line">
                {header.text || <span className="text-muted-foreground italic">Encabezado</span>}
              </p>
            )}
            {header.format === 'IMAGE' && (
              <div className="w-full h-28 bg-border rounded-lg flex items-center justify-center">
                <Image size={28} className="text-muted-foreground" />
                <span className="text-xs text-muted-foreground ml-2">Imagen</span>
              </div>
            )}
            {header.format === 'VIDEO' && (
              <div className="w-full h-28 bg-border rounded-lg flex items-center justify-center">
                <Video size={28} className="text-muted-foreground" />
                <span className="text-xs text-muted-foreground ml-2">Video</span>
              </div>
            )}
            {header.format === 'DOCUMENT' && (
              <div className="w-full h-16 bg-muted rounded-lg flex items-center px-3 gap-2">
                <File size={24} className="text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Documento adjunto</span>
              </div>
            )}
          </div>
        )}
        {/* Body */}
        <div className={`px-3 py-2 ${header ? '' : 'pt-3'} bg-[#d9fdd3]`}>
          {body ? (
            <p className="text-sm text-foreground whitespace-pre-line leading-relaxed">
              {highlightVars(body.text || '')}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground italic">Escribe el cuerpo del mensaje…</p>
          )}
        </div>
        {/* Footer */}
        {footer && footer.text && (
          <div className="px-3 pb-2 bg-[#d9fdd3]">
            <p className="text-xs text-muted-foreground mt-1">{footer.text}</p>
          </div>
        )}
        {/* Timestamp */}
        <div className="px-3 pb-2 bg-[#d9fdd3] flex justify-end">
          <span className="text-[10px] text-muted-foreground">12:00 ✓✓</span>
        </div>
        {/* Buttons */}
        {buttons && buttons.buttons.length > 0 && (
          <div className="border-t border-border">
            {buttons.buttons.map((btn, i) => (
              <button key={i} className="w-full py-2 px-3 text-sm text-[#00a5f4] flex items-center justify-center gap-1.5 border-b border-border last:border-0 hover:bg-background">
                {btn.type === 'PHONE_NUMBER' && <Phone size={13} />}
                {btn.type === 'URL'          && <ExternalLink size={13} />}
                {btn.type === 'QUICK_REPLY'  && <MessageSquare size={13} />}
                {btn.text || <span className="text-muted-foreground/60 italic text-xs">Botón</span>}
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
  bodyExamples: string[]   // ejemplo de {{n}} en la posición n - 1
  footerEnabled: boolean
  footerText: string
  buttonsEnabled: boolean
  buttons: TemplateButton[]
}

const DEFAULT_FORM: FormState = {
  name: '', category: 'MARKETING', language: 'es',
  headerEnabled: false, headerFormat: 'TEXT', headerText: '',
  bodyText: '', bodyExamples: [],
  footerEnabled: false, footerText: '',
  buttonsEnabled: false, buttons: [],
}

// Las secciones activadas se envían aunque estén vacías para que la validación
// las marque; las desactivadas se ignoran.
function formToComponents(f: FormState): TemplateComponent[] {
  const comps: TemplateComponent[] = []
  if (f.headerEnabled) {
    if (f.headerFormat === 'TEXT') {
      comps.push({ type: 'HEADER', format: 'TEXT', text: f.headerText })
    } else {
      comps.push({ type: 'HEADER', format: f.headerFormat })
    }
  }
  comps.push(buildBodyComponent(f.bodyText, f.bodyExamples))
  if (f.footerEnabled) {
    comps.push({ type: 'FOOTER', text: f.footerText })
  }
  if (f.buttonsEnabled) {
    comps.push({ type: 'BUTTONS', buttons: f.buttons })
  }
  return comps
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="text-xs text-destructive mt-1">{message}</p>
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
    bodyExamples:   readBodyExamples(t.components),
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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

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

  function openForm(f: FormState, target: Template | null, mode: 'create' | 'edit') {
    setForm(f)
    setEditTarget(target)
    setSaveError(null)
    setFieldErrors({})
    setModal(mode)
  }

  function openCreate() { openForm(DEFAULT_FORM, null, 'create') }

  function openEdit(t: Template) { openForm(templateToForm(t), t, 'edit') }

  function openDuplicate(t: Template) {
    openForm({ ...templateToForm(t), name: `${t.name}_copia` }, null, 'create')
  }

  async function handleSave() {
    setSaveError(null)
    const payload = {
      name:       form.name,
      category:   form.category,
      language:   form.language,
      components: formToComponents(form),
    }
    // Mismas reglas que la API: no se envía nada si hay campos inválidos.
    // Errores sin campo propio (p. ej. componentes no soportados) van al resumen.
    const showErrors = (errors: Record<string, string>) => {
      setFieldErrors(errors)
      setSaveError(errors.form ?? errors.components ?? 'Revisá los campos marcados.')
    }
    const draft = validateTemplateDraft(payload)
    if (!draft.ok) { showErrors(draft.errors); return }
    setFieldErrors({})
    setSaving(true)
    try {
      const url    = modal === 'edit' && editTarget ? `/api/templates/${editTarget.id}` : '/api/templates'
      const method = modal === 'edit' ? 'PATCH' : 'POST'
      const res    = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const data   = await res.json().catch(() => ({})) as { error?: string; issues?: TemplateIssue[] }
      if (!res.ok) {
        if (data.issues?.length) {
          showErrors(collectTemplateErrors(data.issues, payload.components))
        } else if (res.status >= 500) {
          setSaveError('No se pudo guardar la plantilla. Intentá de nuevo en unos minutos.')
        } else {
          setSaveError(data.error || `Error ${res.status}`)
        }
        return
      }
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
  const bodyVariables     = analyzeBodyVariables(form.bodyText).variables
  const normalizedName    = normalizeTemplateName(form.name)

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-title text-foreground">Plantillas</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Plantillas de mensajes de WhatsApp Business</p>
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
        <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3">
          <AlertCircle size={15} className="shrink-0" /> {rowError}
          <button onClick={() => setRowError(null)} className="ml-auto text-red-400 hover:text-destructive">✕</button>
        </div>
      )}

      {/* Tabla */}
      {loading ? (
        <div className="flex items-center justify-center h-40">
          <Loader2 size={22} className="animate-spin text-muted-foreground/60" />
        </div>
      ) : error ? (
        <div className="text-sm text-destructive bg-destructive/10 rounded-lg px-4 py-3 flex items-center gap-2">
          <AlertCircle size={15} /> {error}
        </div>
      ) : templates.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <FileText size={36} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">No hay plantillas{filterStatus || filterCategory || filterQ ? ' con esos filtros' : ' todavía'}</p>
          {isAdmin && !filterStatus && !filterCategory && !filterQ && (
            <Button variant="ghost" size="sm" onClick={openCreate} className="mt-3 text-sm text-success">
              <Plus size={14} className="mr-1" /> Crear primera plantilla
            </Button>
          )}
        </div>
      ) : (
        <div className="border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-background border-b border-border">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Nombre</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Categoría</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Idioma</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Estado</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Usos</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Actualizada</th>
                {isAdmin && <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">Acciones</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {templates.map(t => (
                <tr key={t.id} className="hover:bg-background transition-colors">
                  <td className="px-4 py-3">
                    <div>
                      <p className="font-medium text-foreground font-mono text-xs">{t.name}</p>
                      {t.rejection_reason && (
                        <p className="text-xs text-red-500 mt-0.5 max-w-xs truncate" title={t.rejection_reason}>
                          ↳ {t.rejection_reason}
                        </p>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{CATEGORY_LABEL[t.category as TemplateCategory]}</td>
                  <td className="px-4 py-3 text-muted-foreground uppercase text-xs">{t.language}</td>
                  <td className="px-4 py-3">
                    <Badge className={STATUS_STYLE[t.status as TemplateStatus]}>
                      {STATUS_LABEL[t.status as TemplateStatus]}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{t.usage_count}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">{fmtDate(t.updated_at)}</td>
                  {isAdmin && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <button onClick={() => openEdit(t)} title="Editar" className="p-1.5 rounded hover:bg-muted text-muted-foreground">
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => openDuplicate(t)} title="Duplicar" className="p-1.5 rounded hover:bg-muted text-muted-foreground">
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
                            className="p-1.5 rounded hover:bg-muted text-muted-foreground disabled:opacity-50"
                          >
                            {syncing === t.id ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                          </button>
                        )}
                        <button
                          onClick={() => void handleDelete(t.id)}
                          disabled={deleting === t.id}
                          title="Eliminar"
                          className="p-1.5 rounded hover:bg-destructive/10 text-red-400 disabled:opacity-50"
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
        {/* DialogContent trae sm:max-w-sm: el ancho se sobrescribe con el mismo breakpoint. */}
        <DialogContent className="sm:max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{modal === 'edit' ? 'Editar plantilla' : 'Nueva plantilla'}</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-2 min-w-0">
            {/* Columna izquierda — formulario */}
            <div className="space-y-4 min-w-0">
              {/* Nombre */}
              <div>
                <label htmlFor="template-name" className="text-sm font-medium text-foreground block mb-1">
                  Nombre <span className="text-red-500">*</span>
                </label>
                <Input
                  id="template-name"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="ej: aviso_soporte"
                  aria-invalid={!!fieldErrors.name}
                  className="h-9 text-sm font-mono"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Solo letras minúsculas sin acentos, números y guiones bajos (_), hasta {TEMPLATE_NAME_MAX} caracteres.
                  Las mayúsculas se pasan a minúsculas y los espacios a _.
                  {normalizedName && normalizedName !== form.name && <> Se guardará como <code className="bg-muted px-1 rounded break-all">{normalizedName}</code>.</>}
                </p>
                <FieldError message={fieldErrors.name} />
              </div>

              {/* Categoría + Idioma */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium text-foreground block mb-1">
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
                  <label className="text-sm font-medium text-foreground block mb-1">
                    Idioma <span className="text-red-500">*</span>
                  </label>
                  <Select value={form.language} onValueChange={v => setForm(f => ({ ...f, language: v ?? f.language }))}>
                    <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LANGUAGES.map(l => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <FieldError message={fieldErrors.language} />
                </div>
              </div>
              <FieldError message={fieldErrors.category} />

              <hr className="border-border" />

              {/* Header */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer mb-2">
                  <input type="checkbox" className="w-4 h-4 accent-green-600"
                    checked={form.headerEnabled}
                    onChange={e => setForm(f => ({ ...f, headerEnabled: e.target.checked }))} />
                  <span className="text-sm font-medium text-foreground">Encabezado (Header)</span>
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
                    <FieldError message={fieldErrors.header} />
                  </div>
                )}
              </div>

              {/* Body */}
              <div>
                <label htmlFor="template-body" className="text-sm font-medium text-foreground block mb-1">
                  Cuerpo del mensaje <span className="text-red-500">*</span>
                </label>
                <Textarea
                  id="template-body"
                  aria-invalid={!!fieldErrors.body}
                  value={form.bodyText}
                  onChange={e => setForm(f => ({ ...f, bodyText: e.target.value }))}
                  placeholder="Escribe el mensaje. Usa {{1}}, {{2}}, etc. para variables."
                  rows={5}
                  maxLength={1024}
                  className="text-sm resize-none"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {form.bodyText.length}/1024 caracteres. Variables:{' '}
                  <code className="bg-muted px-1 rounded">{'{{1}}'}</code>,{' '}
                  <code className="bg-muted px-1 rounded">{'{{2}}'}</code>… consecutivas desde {'{{1}}'}.
                </p>
                <FieldError message={fieldErrors.body} />
                {bodyVariables.length > 0 && (
                  <div className="mt-3 space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Ejemplos de variables (requeridos por Meta para revisar la plantilla)</p>
                    {bodyVariables.map(n => (
                      <div key={n}>
                        <div className="flex items-center gap-2 min-w-0">
                          <code className="bg-blue-50 text-blue-700 px-1 rounded text-xs shrink-0">{`{{${n}}}`}</code>
                          <Input
                            aria-label={`Ejemplo para {{${n}}}`}
                            aria-invalid={!!fieldErrors[`bodyExample.${n}`]}
                            value={form.bodyExamples[n - 1] ?? ''}
                            onChange={e => setForm(f => {
                              const bodyExamples = [...f.bodyExamples]
                              for (let i = 0; i < n - 1; i++) bodyExamples[i] ??= ''
                              bodyExamples[n - 1] = e.target.value
                              return { ...f, bodyExamples }
                            })}
                            placeholder="Valor de ejemplo"
                            className="h-8 text-sm"
                          />
                        </div>
                        <FieldError message={fieldErrors[`bodyExample.${n}`]} />
                      </div>
                    ))}
                    <FieldError message={fieldErrors.bodyExamples} />
                  </div>
                )}
              </div>

              {/* Footer */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer mb-2">
                  <input type="checkbox" className="w-4 h-4 accent-green-600"
                    checked={form.footerEnabled}
                    onChange={e => setForm(f => ({ ...f, footerEnabled: e.target.checked }))} />
                  <span className="text-sm font-medium text-foreground">Pie de página (Footer)</span>
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
                {form.footerEnabled && <div className="ml-6"><FieldError message={fieldErrors.footer} /></div>}
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
                  <span className="text-sm font-medium text-foreground">Botones (máx. 3)</span>
                </label>
                {form.buttonsEnabled && (
                  <div className="space-y-2 pl-6">
                    {form.buttons.map((btn, i) => (
                      <div key={i} className="border border-border rounded-lg p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <Select value={btn.type} onValueChange={v => updateButton(i, { type: v as TemplateButton['type'] })}>
                            <SelectTrigger className="h-7 text-xs flex-1"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="QUICK_REPLY">Respuesta rápida</SelectItem>
                              <SelectItem value="URL">URL</SelectItem>
                              <SelectItem value="PHONE_NUMBER">Teléfono</SelectItem>
                            </SelectContent>
                          </Select>
                          <button onClick={() => removeButton(i)} className="p-1 hover:bg-destructive/10 text-red-400 rounded">
                            <Trash2 size={13} />
                          </button>
                        </div>
                        <Input
                          value={btn.text}
                          onChange={e => updateButton(i, { text: e.target.value })}
                          placeholder="Texto del botón"
                          className="h-7 text-xs"
                          maxLength={TEMPLATE_BUTTON_TEXT_MAX}
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
                        <FieldError message={fieldErrors[`button.${i}`]} />
                      </div>
                    ))}
                    {form.buttons.length < 3 && (
                      <button onClick={addButton} className="text-xs text-success hover:text-success flex items-center gap-1">
                        <Plus size={12} /> Agregar botón
                      </button>
                    )}
                    <FieldError message={fieldErrors.buttons} />
                  </div>
                )}
              </div>
            </div>

            {/* Columna derecha — preview */}
            <div className="space-y-3 min-w-0">
              <div className="flex items-center gap-2">
                <Eye size={14} className="text-muted-foreground" />
                <p className="text-sm font-medium text-muted-foreground">Vista previa en tiempo real</p>
              </div>
              <WhatsAppPreview components={previewComponents} />
              <div className="bg-warning/10 border border-warning/20 rounded-lg px-3 py-2">
                <p className="text-xs text-warning">
                  La aprobación de Meta puede tardar entre minutos y varias horas.
                </p>
              </div>
            </div>
          </div>

          {/* Footer del modal */}
          {saveError && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-2 mt-4">
              <AlertCircle size={14} /> {saveError}
            </div>
          )}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-border mt-4">
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
