'use client'

import { hasAssignedLineVariable, replaceAssignedLineVariable } from '@/lib/assigned-line-variable'
import { useEffect, useState, useCallback } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Bot, Plus, Search, Pencil, Trash2, Power, RefreshCw, AlertTriangle, CheckCircle, XCircle, Clock } from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'

// ── Tipos ─────────────────────────────────────────────────────────────────────

type AutomationType  = 'reply' | 'flow' | 'handoff'
type TriggerType     = 'keyword' | 'contains' | 'any_inbound'

interface TriggerConfig { keywords?: string[]; once_per_chat?: boolean }
interface ReplyActionConfig { message: string; contact_line_directory?: 'ofizeus' }
interface FlowStep { message: string; delay_sec?: number }
interface FlowActionConfig { steps: FlowStep[] }
interface HandoffActionConfig { message?: string }
type ActionConfig = ReplyActionConfig | FlowActionConfig | HandoffActionConfig

interface Automation {
  id: string
  name: string
  description: string | null
  type: AutomationType
  trigger_type: TriggerType
  trigger_config: TriggerConfig
  action_config: ActionConfig
  is_active: boolean
  priority: number
  created_by_name: string | null
  created_at: string
  updated_at: string
}

interface AutomationLog {
  id: string
  automation_id: string | null
  automation_name: string | null
  conversation_phone: string
  message_id: string | null
  result: 'executed' | 'skipped' | 'error'
  details: string | null
  created_at: string
}

// ── Labels ────────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<AutomationType, string> = {
  reply:   'Respuesta automática',
  flow:    'Flujo',
  handoff: 'Derivación a humano',
}
const TYPE_COLORS: Record<AutomationType, string> = {
  reply:   'bg-blue-100 text-blue-800',
  flow:    'bg-purple-100 text-purple-800',
  handoff: 'bg-orange-100 text-orange-800',
}
const TRIGGER_LABELS: Record<TriggerType, string> = {
  keyword:     'Palabra exacta',
  contains:    'Contiene',
  any_inbound: 'Cualquier mensaje',
}
const RESULT_ICON: Record<string, React.ReactNode> = {
  executed: <CheckCircle size={13} className="text-success" />,
  skipped:  <Clock       size={13} className="text-yellow-600" />,
  error:    <XCircle     size={13} className="text-destructive" />,
}
const RESULT_LABEL: Record<string, string> = {
  executed: 'Ejecutada',
  skipped:  'Ignorada',
  error:    'Error',
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ── Estado inicial del formulario ─────────────────────────────────────────────

const BLANK_FORM = {
  name:          '',
  description:   '',
  type:          'reply' as AutomationType,
  trigger_type:  'contains' as TriggerType,
  keywords:      '',          // separados por coma
  message:       '',          // para reply / handoff
  flow_steps:    '',          // para flow: un paso por línea
  handoff_msg:   '',
  priority:      '100',
  is_active:     true,
  once_per_chat: true,
}

// ── Página principal ──────────────────────────────────────────────────────────

export default function AutomatizacionesPage() {
  const [items, setItems]   = useState<Automation[]>([])
  const [logs, setLogs]     = useState<AutomationLog[]>([])
  const [logTotal, setLogTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError]   = useState<string | null>(null)
  const [tab, setTab]       = useState('automatizaciones')

  // Filtros
  const [q, setQ]         = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')

  // Editor modal
  const [showEditor, setShowEditor]   = useState(false)
  const [editTarget, setEditTarget]   = useState<Automation | null>(null)
  const [form, setForm]               = useState({ ...BLANK_FORM })
  const [saving, setSaving]           = useState(false)
  const [saveError, setSaveError]     = useState<string | null>(null)

  // Confirmación eliminar
  const [deleteTarget, setDeleteTarget] = useState<Automation | null>(null)
  const [deleting, setDeleting]         = useState(false)

  // ── Fetch ────────────────────────────────────────────────────────────────────

  const fetchItems = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams({
        ...(q ? { q } : {}),
        ...(typeFilter !== 'all' ? { type: typeFilter } : {}),
        ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
      })
      const data = await fetchJson<{ automations: Automation[] }>(`/api/automations?${params}`)
      setItems(data.automations)
    } catch (e) { setError(e instanceof Error ? e.message : 'Error') }
    finally { setLoading(false) }
  }, [q, typeFilter, statusFilter])

  const [logsError, setLogsError] = useState<string | null>(null)
  const [logsLoading, setLogsLoading] = useState(false)
  const fetchLogs = useCallback(async () => {
    setLogsLoading(true)
    setLogsError(null)
    try {
      const data = await fetchJson<{ logs: AutomationLog[]; total: number }>('/api/automations/logs')
      setLogs(data.logs)
      setLogTotal(data.total)
    } catch (e) { setLogsError(e instanceof Error ? e.message : 'No se pudo cargar el historial') }
    finally { setLogsLoading(false) }
  }, [])

  useEffect(() => { void fetchItems() }, [fetchItems])
  useEffect(() => { if (tab === 'logs') void fetchLogs() }, [tab, fetchLogs])

  // ── Abrir editor ─────────────────────────────────────────────────────────────

  function openCreate() {
    setEditTarget(null)
    setForm({ ...BLANK_FORM })
    setSaveError(null)
    setShowEditor(true)
  }

  function openEdit(a: Automation) {
    setEditTarget(a)
    const ac = a.action_config as Record<string, unknown>
    const tc = a.trigger_config as TriggerConfig

    let message = ''
    let flowSteps = ''
    let handoffMsg = ''

    if (a.type === 'reply') {
      message = (ac.message as string) ?? ''
    } else if (a.type === 'flow') {
      const steps = (ac.steps as FlowStep[]) ?? []
      flowSteps = steps.map(s => s.message).join('\n')
    } else if (a.type === 'handoff') {
      handoffMsg = (ac.message as string) ?? ''
    }

    setForm({
      name:         a.name,
      description:  a.description ?? '',
      type:         a.type,
      trigger_type: a.trigger_type,
      keywords:     (tc.keywords ?? []).join(', '),
      message,
      flow_steps:   flowSteps,
      handoff_msg:  handoffMsg,
      priority:     String(a.priority),
      is_active:    a.is_active,
      once_per_chat: tc.once_per_chat === true,
    })
    setSaveError(null)
    setShowEditor(true)
  }

  // ── Guardar ──────────────────────────────────────────────────────────────────

  async function handleSave() {
    setSaveError(null)
    if (!form.name.trim()) { setSaveError('El nombre es requerido'); return }

    const trigger_config: TriggerConfig = { ...editTarget?.trigger_config, once_per_chat: form.type === 'reply' && form.once_per_chat }
    delete trigger_config.keywords
    if (form.trigger_type !== 'any_inbound') {
      const kws = form.keywords.split(',').map(k => k.trim()).filter(Boolean)
      if (kws.length === 0) { setSaveError('Ingresá al menos una palabra clave'); return }
      trigger_config.keywords = kws
    }

    let action_config: ActionConfig
    if (form.type === 'reply') {
      if (!form.message.trim()) { setSaveError('El mensaje de respuesta es requerido'); return }
      action_config = { message: form.message.trim(), ...(((editTarget?.action_config as ReplyActionConfig)?.contact_line_directory === 'ofizeus' || hasAssignedLineVariable(form.message)) ? { contact_line_directory: 'ofizeus' as const } : {}) }
    } else if (form.type === 'flow') {
      const steps = form.flow_steps.split('\n').map(l => l.trim()).filter(Boolean).map(l => ({ message: l }))
      if (steps.length === 0) { setSaveError('Ingresá al menos un paso'); return }
      action_config = { steps }
    } else {
      action_config = { message: form.handoff_msg.trim() || undefined } as HandoffActionConfig
    }

    const payload = {
      name:           form.name.trim(),
      description:    form.description.trim() || null,
      type:           form.type,
      trigger_type:   form.trigger_type,
      trigger_config,
      action_config,
      is_active:      form.is_active,
      priority:       parseInt(form.priority, 10) || 100,
    }

    setSaving(true)
    try {
      if (editTarget) {
        await fetchJson(`/api/automations/${editTarget.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } else {
        await fetchJson('/api/automations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      }
      setShowEditor(false)
      void fetchItems()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  // ── Toggle activo/pausado ─────────────────────────────────────────────────────

  async function handleToggle(a: Automation) {
    try {
      await fetchJson(`/api/automations/${a.id}/toggle`, { method: 'POST' })
      void fetchItems()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cambiar estado')
    }
  }

  // ── Eliminar ─────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await fetchJson(`/api/automations/${deleteTarget.id}`, { method: 'DELETE' })
      setDeleteTarget(null)
      void fetchItems()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al eliminar')
    } finally {
      setDeleting(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-violet-100 flex items-center justify-center">
            <Bot size={18} className="text-violet-600" />
          </div>
          <div>
            <h1 className="page-title text-foreground">Automatizaciones</h1>
            <p className="text-sm text-muted-foreground">Bots y respuestas automáticas para conversaciones</p>
          </div>
        </div>
        <Button size="sm" onClick={openCreate} className="gap-2 bg-violet-600 hover:bg-violet-700 text-white">
          <Plus size={14} />
          Nueva automatización
        </Button>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="automatizaciones">Automatizaciones</TabsTrigger>
          <TabsTrigger value="logs">Historial de ejecuciones</TabsTrigger>
        </TabsList>

        {/* ── Tab: Automatizaciones ── */}
        <TabsContent value="automatizaciones" className="space-y-4 mt-4">
          {/* Filtros */}
          <Card>
            <CardContent className="pt-4">
              <div className="flex flex-wrap gap-3 items-center">
                <div className="relative flex-1 min-w-[180px]">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input placeholder="Buscar por nombre..." className="pl-8 h-8 text-sm"
                    value={q} onChange={e => setQ(e.target.value)} />
                </div>
                <Select value={typeFilter} onValueChange={v => setTypeFilter(v ?? 'all')}>
                  <SelectTrigger className="h-8 text-sm w-44"><SelectValue placeholder="Tipo" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos los tipos</SelectItem>
                    <SelectItem value="reply">Respuesta automática</SelectItem>
                    <SelectItem value="flow">Flujo</SelectItem>
                    <SelectItem value="handoff">Derivación a humano</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={statusFilter} onValueChange={v => setStatusFilter(v ?? 'all')}>
                  <SelectTrigger className="h-8 text-sm w-40"><SelectValue placeholder="Estado" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos</SelectItem>
                    <SelectItem value="active">Activas</SelectItem>
                    <SelectItem value="paused">Pausadas</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="ghost" size="sm" onClick={() => void fetchItems()} className="gap-1">
                  <RefreshCw size={13} />
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Tabla */}
          <Card>
            <CardContent className="p-0">
              {error && (
                <div className="p-4 text-sm text-destructive flex items-center gap-2">
                  <AlertTriangle size={14} /> {error}
                </div>
              )}
              {loading ? (
                <div className="p-8 text-center text-sm text-muted-foreground">Cargando...</div>
              ) : items.length === 0 ? (
                <div className="p-12 text-center">
                  <Bot size={32} className="mx-auto text-muted-foreground/60 mb-3" />
                  <p className="text-sm font-medium text-muted-foreground">Sin automatizaciones configuradas</p>
                  <p className="text-xs text-muted-foreground mt-1">Creá tu primera automatización para responder mensajes automáticamente.</p>
                  <Button size="sm" className="mt-4 bg-violet-600 hover:bg-violet-700 text-white" onClick={openCreate}>
                    <Plus size={13} className="mr-1" /> Crear automatización
                  </Button>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-background border-b border-border">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Nombre</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Tipo</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Trigger</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Estado</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Prioridad</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Modificada</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Acciones</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {items.map(item => {
                        const tc = item.trigger_config as TriggerConfig
                        const kws = tc.keywords ?? []
                        return (
                          <tr key={item.id} className="hover:bg-background">
                            <td className="px-4 py-3">
                              <div className="font-medium text-foreground">{item.name}</div>
                              {item.description && (
                                <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{item.description}</div>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${TYPE_COLORS[item.type]}`}>
                                {TYPE_LABELS[item.type]}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <div className="text-xs text-muted-foreground font-medium">{TRIGGER_LABELS[item.trigger_type]}</div>
                              {kws.length > 0 && (
                                <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                                  {kws.slice(0, 3).join(', ')}{kws.length > 3 ? ` +${kws.length - 3}` : ''}
                                </div>
                              )}
                              {item.type === 'reply' && tc.once_per_chat === true && (
                                <div className="mt-1 text-xs font-medium text-primary">Una vez por chat</div>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <Badge className={`text-xs border-0 ${item.is_active ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'}`}>
                                {item.is_active ? 'Activa' : 'Pausada'}
                              </Badge>
                            </td>
                            <td className="px-4 py-3 text-xs text-muted-foreground text-center">{item.priority}</td>
                            <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{fmt(item.updated_at)}</td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => handleToggle(item)}
                                  className={`p-1.5 rounded transition-colors ${item.is_active ? 'text-success hover:bg-success/10' : 'text-muted-foreground hover:bg-muted'}`}
                                  title={item.is_active ? 'Pausar' : 'Activar'}
                                >
                                  <Power size={14} />
                                </button>
                                <button onClick={() => openEdit(item)}
                                  className="p-1.5 rounded hover:bg-blue-50 text-muted-foreground hover:text-blue-600 transition-colors"
                                  title="Editar">
                                  <Pencil size={14} />
                                </button>
                                <button onClick={() => setDeleteTarget(item)}
                                  className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                                  title="Eliminar">
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab: Logs ── */}
        <TabsContent value="logs" className="space-y-4 mt-4">
          <Card>
            <CardContent className="p-0">
              {logsLoading ? (
                <div className="p-10 text-center text-sm text-muted-foreground">Cargando historial…</div>
              ) : logsError ? (
                <div className="p-6 text-center space-y-3" role="alert">
                  <p className="text-sm text-destructive">{logsError}</p>
                  <Button variant="outline" onClick={() => void fetchLogs()}>Reintentar</Button>
                </div>
              ) : logs.length === 0 ? (
                <div className="p-10 text-center text-sm text-muted-foreground">
                  Sin ejecuciones registradas aún.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-background border-b border-border">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Resultado</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Automatización</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Teléfono</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Detalle</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Fecha</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {logs.map(log => (
                        <tr key={log.id} className="hover:bg-background">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5 text-xs font-medium">
                              {RESULT_ICON[log.result]}
                              <span className={log.result === 'executed' ? 'text-success' : log.result === 'error' ? 'text-destructive' : 'text-yellow-700'}>
                                {RESULT_LABEL[log.result] ?? log.result}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-foreground text-xs">{log.automation_name ?? '—'}</td>
                          <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{log.conversation_phone}</td>
                          <td className="px-4 py-3 text-xs text-muted-foreground max-w-[200px] line-clamp-1">{log.details ?? '—'}</td>
                          <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{fmt(log.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="px-4 py-3 border-t border-border">
                    <span className="text-xs text-muted-foreground">{logTotal} ejecuciones en total (mostrando últimas 50)</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Modal: Editor ── */}
      <Dialog open={showEditor} onOpenChange={open => { if (!open) setShowEditor(false) }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bot size={16} className="text-violet-600" />
              {editTarget ? 'Editar automatización' : 'Nueva automatización'}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-5 pt-1">
            {/* Nombre y descripción */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">Nombre *</label>
                <Input
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Ej: Respuesta precio"
                  className="text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">Prioridad</label>
                <Input
                  type="number"
                  min={1} max={1000}
                  value={form.priority}
                  onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                  className="text-sm"
                />
                <p className="text-xs text-muted-foreground mt-1">Menor número = mayor prioridad. Se evalúa primero.</p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Descripción (opcional)</label>
              <Input
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Para qué sirve esta automatización..."
                className="text-sm"
              />
            </div>

            {/* Tipo */}
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">Tipo de automatización *</label>
              <div className="grid grid-cols-3 gap-2">
                {(['reply', 'flow', 'handoff'] as AutomationType[]).map(t => (
                  <button
                    key={t}
                    onClick={() => setForm(f => ({ ...f, type: t }))}
                    className={`p-3 rounded-lg border-2 text-left transition-colors ${form.type === t ? 'border-violet-500 bg-violet-50' : 'border-border hover:border-input'}`}
                  >
                    <div className="text-xs font-semibold text-foreground">{TYPE_LABELS[t]}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {t === 'reply'   && 'Responde con un mensaje fijo'}
                      {t === 'flow'    && 'Secuencia de mensajes'}
                      {t === 'handoff' && 'Deriva a un agente humano'}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Trigger */}
            <div className="space-y-3 border border-border rounded-lg p-4">
              <p className="text-sm font-medium text-foreground">Condición de activación (trigger)</p>

              <div>
                <label className="block text-xs text-muted-foreground mb-1">Tipo de trigger</label>
                <Select value={form.trigger_type} onValueChange={v => setForm(f => ({ ...f, trigger_type: (v ?? 'contains') as TriggerType }))}>
                  <SelectTrigger className="text-sm h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="keyword">Palabra exacta — el mensaje es exactamente la keyword</SelectItem>
                    <SelectItem value="contains">Contiene — el mensaje incluye la keyword</SelectItem>
                    <SelectItem value="any_inbound">Cualquier mensaje entrante</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {form.trigger_type !== 'any_inbound' && (
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    Palabras clave (separadas por coma) *
                  </label>
                  <Input
                    value={form.keywords}
                    onChange={e => setForm(f => ({ ...f, keywords: e.target.value }))}
                    placeholder="precio, costo, tarifa, cuánto vale"
                    className="text-sm"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Sin acentos, sin mayúsculas — el sistema normaliza automáticamente.
                  </p>
                </div>
              )}
            </div>

            {/* Frecuencia de la respuesta */}
            {form.type === 'reply' && (
              <div className="rounded-lg border border-border p-4 space-y-2">
                <label className="flex items-start gap-2 text-sm font-medium">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={form.once_per_chat}
                    onChange={event => setForm(f => ({ ...f, once_per_chat: event.target.checked }))} />
                  Enviar esta respuesta solo una vez por chat
                </label>
                <p className="text-xs text-muted-foreground">Cada teléfono recibe esta respuesta una sola vez, aunque vuelva a escribir o tocar otro botón de la misma automatización. Se tienen en cuenta los envíos anteriores y las distintas líneas. El límite no se reinicia al día siguiente ni al editar el texto.</p>
              </div>
            )}

            {/* Acción según tipo */}
            <div className="space-y-3 border border-border rounded-lg p-4">
              <p className="text-sm font-medium text-foreground">Acción a ejecutar</p>

              {form.type === 'reply' && (
                <div>
                  <p className="mb-3 rounded-md border p-3 text-sm">Usá <code>{'{{2}}'}</code> donde quieras mostrar el número de la línea asignada de Ofizeus, separado por barras. Respeta la línea y variante del contacto. Si falta una asignación activa, avisa que lo atenderá un asesor y deriva la conversación.</p>
                  <label className="block text-xs text-muted-foreground mb-1">Mensaje de respuesta *</label>
                  <textarea
                    className="w-full border border-input rounded-md text-sm px-3 py-2 h-28 resize-none focus:outline-none focus:ring-2 focus:ring-violet-500"
                    value={form.message}
                    onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
                    placeholder="Hola {{nombre}}! Gracias por contactarnos. Un asesor te escribirá a la brevedad."
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Variables disponibles: <code className="bg-muted px-1 rounded">{'{{nombre}}'}</code>{' '}
                    <code className="bg-muted px-1 rounded">{'{{empresa}}'}</code>{' '}
                    <code className="bg-muted px-1 rounded">{'{{fecha}}'}</code>{' '}
                    <code className="bg-muted px-1 rounded">{'{{2}}'}</code> (línea de Ofizeus)
                  </p>
                </div>
              )}

              {form.type === 'reply' && hasAssignedLineVariable(form.message) && <div className="rounded-md bg-muted/40 p-3" aria-label="Vista previa de línea asignada">
                <p className="mb-2 text-xs font-medium text-muted-foreground">Ejemplo: contacto de Ofizeus, línea 3A</p>
                <p className="whitespace-pre-wrap break-words text-sm">{replaceAssignedLineVariable(form.message, '549 | 1124 | 915455')}</p>
              </div>}

              {form.type === 'flow' && (
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    Pasos del flujo (un mensaje por línea) *
                  </label>
                  <textarea
                    className="w-full border border-input rounded-md text-sm px-3 py-2 h-32 resize-none focus:outline-none focus:ring-2 focus:ring-violet-500"
                    value={form.flow_steps}
                    onChange={e => setForm(f => ({ ...f, flow_steps: e.target.value }))}
                    placeholder={`Hola {{nombre}}! ¿En qué podemos ayudarte hoy?\nOpción 1: Consultas\nOpción 2: Soporte`}
                  />
                  <p className="text-xs text-amber-600 bg-warning/10 rounded px-2 py-1 mt-1">
                    Escribí un mensaje por línea. Los pasos se procesan en orden; revisá el resultado de cada uno en Historial de ejecuciones.
                  </p>
                </div>
              )}

              {form.type === 'handoff' && (
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    Mensaje previo a la derivación (opcional)
                  </label>
                  <textarea
                    className="w-full border border-input rounded-md text-sm px-3 py-2 h-20 resize-none focus:outline-none focus:ring-2 focus:ring-violet-500"
                    value={form.handoff_msg}
                    onChange={e => setForm(f => ({ ...f, handoff_msg: e.target.value }))}
                    placeholder="Entendido, {{nombre}}! Te estamos conectando con un asesor. 🙏"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    La conversación se marcará como &quot;Necesita atención humana&quot; automáticamente.
                  </p>
                </div>
              )}
            </div>

            {/* Estado */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">Estado inicial</p>
                <p className="text-xs text-muted-foreground">Las automatizaciones pausadas no se ejecutan</p>
              </div>
              <button
                onClick={() => setForm(f => ({ ...f, is_active: !f.is_active }))}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${form.is_active ? 'bg-green-500' : 'bg-gray-300'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-card shadow transition-transform ${form.is_active ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>

            {saveError && (
              <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">
                <AlertTriangle size={14} /> {saveError}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1 border-t border-border">
              <Button variant="outline" size="sm" onClick={() => setShowEditor(false)}>Cancelar</Button>
              <Button size="sm" onClick={handleSave} disabled={saving}
                className="bg-violet-600 hover:bg-violet-700 text-white">
                {saving ? 'Guardando...' : editTarget ? 'Guardar cambios' : 'Crear automatización'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Modal: Confirmar eliminación ── */}
      <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle size={16} className="text-red-500" />
              Eliminar automatización
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-1">
            <p className="text-sm text-foreground">
              ¿Estás seguro de que querés eliminar <span className="font-semibold">{deleteTarget?.name}</span>?
            </p>
            <p className="text-xs text-muted-foreground">
              Esta acción no se puede deshacer. El historial de ejecuciones se conservará.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>Cancelar</Button>
              <Button size="sm" onClick={handleDelete} disabled={deleting}
                className="bg-red-600 hover:bg-red-700 text-white">
                {deleting ? 'Eliminando...' : 'Sí, eliminar'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
