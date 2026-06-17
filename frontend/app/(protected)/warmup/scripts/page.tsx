'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent }                from '@/components/ui/card'
import { Badge }                            from '@/components/ui/badge'
import { Button }                           from '@/components/ui/button'
import { Input }                            from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  Plus, Trash2, RefreshCw, MessageSquare, Play, Pause,
  CheckCircle, AlertCircle, Loader2, ChevronDown, ChevronUp,
  ArrowRight, FileText, Users,
} from 'lucide-react'
import { fetchJson }                                       from '@/lib/fetchJson'
import { parseConversationScript, type ParsedStep }        from '@/lib/warmup-script-parser'

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface WarmupScript {
  id:          string
  name:        string
  description: string | null
  total_steps: number
  created_at:  string
}

interface Conversation {
  id:               string
  script_id:        string
  script_name:      string
  line_a_id:        string
  line_b_id:        string
  line_a_phone:     string
  line_b_phone:     string
  line_a_instance:  string
  line_b_instance:  string
  alias_a:          string
  alias_b:          string
  current_step:     number
  total_steps:      number
  status:           'pending' | 'in_progress' | 'completed' | 'failed' | 'paused'
  next_send_at:     string | null
  messages_sent:    number
  started_at:       string | null
  completed_at:     string | null
  created_at:       string
}

interface WarmupLine {
  id:            string
  phone_number:  string
  instance_name: string
  warmup_status: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_CFG = {
  pending:     { label: 'Pendiente',  cls: 'bg-gray-100 text-gray-600'  },
  in_progress: { label: 'En curso',   cls: 'bg-blue-100 text-blue-700'  },
  completed:   { label: 'Completada', cls: 'bg-green-100 text-green-700' },
  failed:      { label: 'Error',      cls: 'bg-red-100 text-red-700'    },
  paused:      { label: 'Pausada',    cls: 'bg-yellow-100 text-yellow-700' },
} as const

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: '2-digit' })
}

function timeAgo(iso: string | null) {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1)  return 'ahora'
  if (m < 60) return `hace ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `hace ${h}h`
  return `hace ${Math.floor(h / 24)}d`
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function WarmupScriptsPage() {
  const [scripts,       setScripts]       = useState<WarmupScript[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [lines,         setLines]         = useState<WarmupLine[]>([])
  const [loading,       setLoading]       = useState(true)
  const [tab,           setTab]           = useState<'scripts' | 'conversations'>('scripts')

  // Modal nuevo script
  const [showNewScript,  setShowNewScript]  = useState(false)

  // Modal nueva conversación
  const [showNewConv,    setShowNewConv]    = useState(false)
  const [selectedScript, setSelectedScript] = useState<WarmupScript | null>(null)

  // ── Carga inicial ─────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, c, l] = await Promise.all([
        fetchJson<{ scripts: WarmupScript[] }>('/api/warmup/scripts'),
        fetchJson<{ conversations: Conversation[] }>('/api/warmup/conversations?status=all'),
        fetchJson<{ numbers: WarmupLine[] }>('/api/warmup'),
      ])
      setScripts(s.scripts ?? [])
      setConversations(c.conversations ?? [])
      setLines((l as any).numbers ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // ── Acciones ──────────────────────────────────────────────────────────────

  async function deleteScript(id: string) {
    if (!confirm('¿Eliminar este script? También se eliminarán sus pasos.')) return
    await fetchJson(`/api/warmup/scripts/${id}`, { method: 'DELETE' })
    load()
  }

  async function pauseConversation(id: string) {
    await fetchJson(`/api/warmup/conversations/${id}`, {
      method: 'PATCH',
      body:   JSON.stringify({ status: 'paused' }),
    })
    load()
  }

  async function resumeConversation(id: string) {
    await fetchJson(`/api/warmup/conversations/${id}`, {
      method: 'PATCH',
      body:   JSON.stringify({ status: 'pending' }),
    })
    load()
  }

  async function deleteConversation(id: string) {
    if (!confirm('¿Eliminar esta conversación?')) return
    await fetchJson(`/api/warmup/conversations/${id}`, { method: 'DELETE' })
    load()
  }

  // ── Estadísticas rápidas ──────────────────────────────────────────────────

  const activeConvs    = conversations.filter(c => c.status === 'in_progress' || c.status === 'pending')
  const completedConvs = conversations.filter(c => c.status === 'completed')

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 p-6 max-w-6xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Conversaciones entre líneas</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Guiones reales que las propias líneas se envían entre sí
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </Button>
          {tab === 'scripts' && (
            <Button size="sm" onClick={() => setShowNewScript(true)}>
              <Plus size={14} className="mr-1" /> Nuevo script
            </Button>
          )}
          {tab === 'conversations' && (
            <Button size="sm" onClick={() => setShowNewConv(true)} disabled={scripts.length === 0}>
              <Plus size={14} className="mr-1" /> Nueva conversación
            </Button>
          )}
        </div>
      </div>

      {/* Resumen */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard icon={<FileText size={16} />}  label="Scripts cargados"    value={scripts.length}       />
        <StatCard icon={<MessageSquare size={16}/>} label="Conversaciones activas" value={activeConvs.length} highlight={activeConvs.length > 0} />
        <StatCard icon={<CheckCircle size={16} />} label="Completadas"         value={completedConvs.length} />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {(['scripts', 'conversations'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? 'border-gray-900 text-gray-900'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t === 'scripts' ? `Scripts (${scripts.length})` : `Conversaciones (${conversations.length})`}
          </button>
        ))}
      </div>

      {/* Tab: Scripts */}
      {tab === 'scripts' && (
        <div className="space-y-3">
          {loading && <LoadingRow />}
          {!loading && scripts.length === 0 && (
            <EmptyState
              icon={<FileText size={32} className="text-gray-300" />}
              title="Sin scripts cargados"
              subtitle='Hacé clic en "Nuevo script" para cargar una conversación'
            />
          )}
          {scripts.map(script => (
            <ScriptRow
              key={script.id}
              script={script}
              onDelete={() => deleteScript(script.id)}
              onUse={() => { setSelectedScript(script); setShowNewConv(true); setTab('conversations') }}
            />
          ))}
        </div>
      )}

      {/* Tab: Conversaciones */}
      {tab === 'conversations' && (
        <div className="space-y-3">
          {loading && <LoadingRow />}
          {!loading && conversations.length === 0 && (
            <EmptyState
              icon={<MessageSquare size={32} className="text-gray-300" />}
              title="Sin conversaciones"
              subtitle="Creá una conversación asignando un script a dos líneas"
            />
          )}
          {conversations.map(conv => (
            <ConversationRow
              key={conv.id}
              conv={conv}
              onPause={() => pauseConversation(conv.id)}
              onResume={() => resumeConversation(conv.id)}
              onDelete={() => deleteConversation(conv.id)}
            />
          ))}
        </div>
      )}

      {/* Modal: Nuevo script */}
      <NewScriptModal
        open={showNewScript}
        onClose={() => setShowNewScript(false)}
        onCreated={load}
      />

      {/* Modal: Nueva conversación */}
      <NewConversationModal
        open={showNewConv}
        onClose={() => { setShowNewConv(false); setSelectedScript(null) }}
        onCreated={() => { load(); setTab('conversations') }}
        scripts={scripts}
        lines={lines}
        preselectedScript={selectedScript}
      />
    </div>
  )
}

// ── StatCard ──────────────────────────────────────────────────────────────────

function StatCard({ icon, label, value, highlight }: {
  icon:       React.ReactNode
  label:      string
  value:      number
  highlight?: boolean
}) {
  return (
    <Card className="border border-gray-100">
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`${highlight ? 'text-blue-500' : 'text-gray-400'}`}>{icon}</div>
        <div>
          <p className="text-[10px] text-gray-400 uppercase tracking-wide">{label}</p>
          <p className={`text-2xl font-bold leading-tight ${highlight ? 'text-blue-600' : 'text-gray-800'}`}>
            {value}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

// ── ScriptRow ─────────────────────────────────────────────────────────────────

function ScriptRow({ script, onDelete, onUse }: {
  script:   WarmupScript
  onDelete: () => void
  onUse:    () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [steps,    setSteps]    = useState<{ step_order: number; speaker_alias: string; content: string }[]>([])
  const [loadingSteps, setLoadingSteps] = useState(false)

  async function loadSteps() {
    if (steps.length > 0) { setExpanded(e => !e); return }
    setLoadingSteps(true)
    try {
      const res = await fetchJson<{ steps: typeof steps }>(`/api/warmup/scripts/${script.id}`)
      setSteps(res.steps ?? [])
      setExpanded(true)
    } finally {
      setLoadingSteps(false)
    }
  }

  return (
    <Card className="border border-gray-100 hover:border-gray-200 transition-colors">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <FileText size={16} className="text-gray-400 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium text-gray-800 text-sm truncate">{script.name}</p>
              {script.description && (
                <p className="text-xs text-gray-400 truncate">{script.description}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-4">
            <span className="text-xs text-gray-400">{script.total_steps} pasos</span>
            <span className="text-xs text-gray-300">·</span>
            <span className="text-xs text-gray-400">{fmtDate(script.created_at)}</span>
            <button
              onClick={loadSteps}
              className="p-1 text-gray-400 hover:text-gray-600"
            >
              {loadingSteps
                ? <Loader2 size={14} className="animate-spin" />
                : expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />
              }
            </button>
            <Button size="sm" variant="outline" onClick={onUse} className="h-7 text-xs">
              <Play size={12} className="mr-1" /> Usar
            </Button>
            <button onClick={onDelete} className="p-1 text-gray-400 hover:text-red-500">
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        {/* Preview de pasos */}
        {expanded && steps.length > 0 && (
          <div className="mt-3 border-t border-gray-100 pt-3 space-y-1.5 max-h-64 overflow-y-auto">
            {steps.map((s, i) => {
              const isBurst = i < steps.length - 1 && steps[i + 1].speaker_alias === s.speaker_alias
              return (
                <div key={s.step_order} className="flex gap-2 text-xs">
                  <span className="text-gray-400 w-5 text-right shrink-0">{s.step_order}</span>
                  <span className="font-semibold text-gray-700 shrink-0 w-20 truncate">{s.speaker_alias}:</span>
                  <span className="text-gray-600 flex-1">{s.content}</span>
                  {isBurst && (
                    <span className="text-[10px] text-blue-400 shrink-0">burst ↓</span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── ConversationRow ───────────────────────────────────────────────────────────

function ConversationRow({ conv, onPause, onResume, onDelete }: {
  conv:     Conversation
  onPause:  () => void
  onResume: () => void
  onDelete: () => void
}) {
  const cfg      = STATUS_CFG[conv.status]
  const progress = conv.total_steps > 0
    ? Math.round(((conv.current_step - 1) / conv.total_steps) * 100)
    : 0

  return (
    <Card className="border border-gray-100">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-4">

          {/* Info principal */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <p className="text-sm font-medium text-gray-800 truncate">{conv.script_name}</p>
              <Badge className={`text-[10px] px-1.5 py-0.5 ${cfg.cls}`}>{cfg.label}</Badge>
            </div>

            {/* Líneas */}
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <span className="font-medium text-gray-700">{conv.alias_a}</span>
              <span className="text-gray-300 text-[10px]">{conv.line_a_instance}</span>
              <ArrowRight size={10} className="text-gray-300" />
              <span className="font-medium text-gray-700">{conv.alias_b}</span>
              <span className="text-gray-300 text-[10px]">{conv.line_b_instance}</span>
            </div>
          </div>

          {/* Progreso */}
          <div className="text-center shrink-0 w-24">
            <p className="text-xs text-gray-400">Paso</p>
            <p className="text-sm font-semibold text-gray-700">
              {conv.current_step - 1}/{conv.total_steps}
            </p>
            <div className="h-1 bg-gray-100 rounded-full mt-1">
              <div
                className="h-1 bg-blue-400 rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* Próximo envío */}
          <div className="text-center shrink-0 w-24 hidden sm:block">
            <p className="text-xs text-gray-400">Próximo</p>
            <p className="text-xs font-medium text-gray-600">
              {conv.status === 'completed' ? '—' : timeAgo(conv.next_send_at)}
            </p>
          </div>

          {/* Acciones */}
          <div className="flex items-center gap-1 shrink-0">
            {(conv.status === 'in_progress' || conv.status === 'pending') && (
              <button onClick={onPause} className="p-1.5 text-gray-400 hover:text-yellow-600" title="Pausar">
                <Pause size={14} />
              </button>
            )}
            {conv.status === 'paused' && (
              <button onClick={onResume} className="p-1.5 text-gray-400 hover:text-blue-600" title="Reanudar">
                <Play size={14} />
              </button>
            )}
            <button onClick={onDelete} className="p-1.5 text-gray-400 hover:text-red-500" title="Eliminar">
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Modal: Nuevo script ───────────────────────────────────────────────────────

function NewScriptModal({ open, onClose, onCreated }: {
  open:      boolean
  onClose:   () => void
  onCreated: () => void
}) {
  const [name,        setName]        = useState('')
  const [description, setDescription] = useState('')
  const [raw,         setRaw]         = useState('')
  const [parsed,      setParsed]      = useState<{ steps: ParsedStep[]; aliases: string[]; errors: string[] } | null>(null)
  const [saving,      setSaving]      = useState(false)
  const [error,       setError]       = useState('')

  function handleRawChange(val: string) {
    setRaw(val)
    if (val.trim().length > 0) {
      setParsed(parseConversationScript(val))
    } else {
      setParsed(null)
    }
  }

  async function handleSave() {
    if (!name.trim())           return setError('El nombre es requerido')
    if (!parsed || parsed.steps.length < 2) return setError('El script necesita al menos 2 pasos')
    if (parsed.errors.length > 0) return setError('Corregí los errores antes de guardar')

    setSaving(true)
    setError('')
    try {
      await fetchJson('/api/warmup/scripts', {
        method: 'POST',
        body:   JSON.stringify({
          name:        name.trim(),
          description: description.trim() || undefined,
          steps:       parsed.steps.map(s => ({
            stepOrder:    s.stepOrder,
            speakerAlias: s.speakerAlias,
            content:      s.content,
          })),
        }),
      })
      setName(''); setDescription(''); setRaw(''); setParsed(null)
      onCreated()
      onClose()
    } catch (e: any) {
      setError(e.message ?? 'Error al guardar')
    } finally {
      setSaving(false)
    }
  }

  function handleClose() {
    setName(''); setDescription(''); setRaw(''); setParsed(null); setError('')
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nuevo script de conversación</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1">Nombre *</label>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Ej: Playa sábado"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700 block mb-1">Descripción (opcional)</label>
              <Input
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Contexto del script"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-700 block mb-1">
              Conversación <span className="text-gray-400 font-normal">— formato: Nombre: mensaje</span>
            </label>
            <textarea
              className="w-full h-52 text-sm font-mono border border-gray-200 rounded-md p-3 resize-y focus:outline-none focus:ring-1 focus:ring-gray-400"
              value={raw}
              onChange={e => handleRawChange(e.target.value)}
              placeholder={`Lucas: Che Martín, ¿qué hacés este finde?\nMartín: Nada che, tranqui en casa. ¿Por?\nLucas: ¿Te pinta ir a la playa el sábado temprano?\nLucas: Llevo la heladerita.\nMartín: ¡Buenísima idea! ¿A qué hora?`}
              spellCheck={false}
            />
          </div>

          {/* Feedback del parser */}
          {parsed && (
            <div className="space-y-2">
              {parsed.errors.length > 0 && (
                <div className="rounded-md bg-red-50 border border-red-100 p-3 space-y-1">
                  {parsed.errors.map((e, i) => (
                    <p key={i} className="text-xs text-red-600 flex gap-1.5">
                      <AlertCircle size={12} className="shrink-0 mt-0.5" /> {e}
                    </p>
                  ))}
                </div>
              )}

              {parsed.errors.length === 0 && parsed.steps.length > 0 && (
                <div className="rounded-md bg-green-50 border border-green-100 p-3">
                  <p className="text-xs text-green-700 font-medium flex items-center gap-1.5 mb-2">
                    <CheckCircle size={12} /> {parsed.steps.length} pasos detectados
                  </p>
                  <div className="flex gap-3">
                    {parsed.aliases.map(alias => (
                      <Badge key={alias} className="text-xs bg-green-100 text-green-700">
                        <Users size={10} className="mr-1" /> {alias}
                      </Badge>
                    ))}
                  </div>

                  {/* Preview de bursts */}
                  {(() => {
                    const bursts = parsed.steps.filter((s, i) =>
                      i < parsed.steps.length - 1 &&
                      parsed.steps[i + 1].speakerAlias === s.speakerAlias
                    ).length
                    return bursts > 0 ? (
                      <p className="text-xs text-green-600 mt-1.5">
                        {bursts} burst{bursts > 1 ? 's' : ''} detectado{bursts > 1 ? 's' : ''} (delay corto 15-45s)
                      </p>
                    ) : null
                  })()}
                </div>
              )}
            </div>
          )}

          {error && (
            <p className="text-xs text-red-600 flex gap-1.5">
              <AlertCircle size={12} className="shrink-0 mt-0.5" /> {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={handleClose}>Cancelar</Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving || !parsed || parsed.steps.length < 2 || parsed.errors.length > 0}
            >
              {saving ? <Loader2 size={14} className="animate-spin mr-1" /> : null}
              Guardar script
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Modal: Nueva conversación ─────────────────────────────────────────────────

function NewConversationModal({ open, onClose, onCreated, scripts, lines, preselectedScript }: {
  open:               boolean
  onClose:            () => void
  onCreated:          () => void
  scripts:            WarmupScript[]
  lines:              WarmupLine[]
  preselectedScript:  WarmupScript | null
}) {
  const [scriptId,   setScriptId]   = useState('')
  const [scriptSteps, setScriptSteps] = useState<{ speaker_alias: string }[]>([])
  const [aliases,    setAliases]    = useState<string[]>([])
  const [aliasA,     setAliasA]     = useState('')
  const [aliasB,     setAliasB]     = useState('')
  const [lineAId,    setLineAId]    = useState('')
  const [lineBId,    setLineBId]    = useState('')
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState('')

  useEffect(() => {
    if (preselectedScript) {
      setScriptId(preselectedScript.id)
      loadAliases(preselectedScript.id)
    }
  }, [preselectedScript])

  async function loadAliases(id: string) {
    const res = await fetchJson<{ steps: { speaker_alias: string }[] }>(`/api/warmup/scripts/${id}`)
    const unique = [...new Set((res.steps ?? []).map(s => s.speaker_alias))]
    setAliases(unique)
    setAliasA(unique[0] ?? '')
    setAliasB(unique[1] ?? '')
  }

  async function handleScriptChange(id: string) {
    setScriptId(id)
    setAliases([])
    setAliasA('')
    setAliasB('')
    if (id) await loadAliases(id)
  }

  async function handleSave() {
    if (!scriptId || !lineAId || !lineBId || !aliasA || !aliasB) {
      return setError('Completá todos los campos')
    }
    if (lineAId === lineBId) return setError('Las dos líneas deben ser distintas')

    setSaving(true)
    setError('')
    try {
      await fetchJson('/api/warmup/conversations', {
        method: 'POST',
        body:   JSON.stringify({ scriptId, lineAId, lineBId, aliasA, aliasB }),
      })
      handleClose()
      onCreated()
    } catch (e: any) {
      setError(e.message ?? 'Error al crear conversación')
    } finally {
      setSaving(false)
    }
  }

  function handleClose() {
    setScriptId(''); setAliases([]); setAliasA(''); setAliasB('')
    setLineAId(''); setLineBId(''); setError('')
    onClose()
  }

  const activeLines = lines.filter(l => l.warmup_status === 'active')

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nueva conversación</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">

          {/* Script */}
          <div>
            <label className="text-xs font-medium text-gray-700 block mb-1">Script *</label>
            <select
              className="w-full text-sm border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-gray-400"
              value={scriptId}
              onChange={e => handleScriptChange(e.target.value)}
            >
              <option value="">— Seleccionar script —</option>
              {scripts.map(s => (
                <option key={s.id} value={s.id}>{s.name} ({s.total_steps} pasos)</option>
              ))}
            </select>
          </div>

          {/* Mapeo de aliases → líneas */}
          {aliases.length >= 2 && (
            <div className="rounded-md border border-gray-100 bg-gray-50 p-3 space-y-3">
              <p className="text-xs font-medium text-gray-600">Asignar participantes a líneas</p>
              {[{ alias: aliasA, setAlias: setAliasA, lineId: lineAId, setLineId: setLineAId, label: 'Participante A' },
                { alias: aliasB, setAlias: setAliasB, lineId: lineBId, setLineId: setLineBId, label: 'Participante B' }
              ].map(({ alias, setAlias, lineId, setLineId, label }) => (
                <div key={label} className="grid grid-cols-2 gap-2 items-center">
                  <div>
                    <p className="text-[10px] text-gray-400 mb-1">{label} (alias en script)</p>
                    <select
                      className="w-full text-sm border border-gray-200 rounded-md px-2 py-1.5 focus:outline-none"
                      value={alias}
                      onChange={e => setAlias(e.target.value)}
                    >
                      {aliases.map(a => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-400 mb-1">Línea de WhatsApp</p>
                    <select
                      className="w-full text-sm border border-gray-200 rounded-md px-2 py-1.5 focus:outline-none"
                      value={lineId}
                      onChange={e => setLineId(e.target.value)}
                    >
                      <option value="">— Línea —</option>
                      {activeLines.map(l => (
                        <option key={l.id} value={l.id}>{l.instance_name}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeLines.length === 0 && (
            <p className="text-xs text-yellow-600 flex gap-1.5">
              <AlertCircle size={12} className="shrink-0 mt-0.5" />
              No hay líneas activas. Activá al menos dos líneas en el módulo de warmup.
            </p>
          )}

          {error && (
            <p className="text-xs text-red-600 flex gap-1.5">
              <AlertCircle size={12} className="shrink-0 mt-0.5" /> {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={handleClose}>Cancelar</Button>
            <Button size="sm" onClick={handleSave} disabled={saving || !scriptId || !lineAId || !lineBId}>
              {saving ? <Loader2 size={14} className="animate-spin mr-1" /> : null}
              Iniciar conversación
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Auxiliares ────────────────────────────────────────────────────────────────

function LoadingRow() {
  return (
    <div className="flex items-center justify-center py-10">
      <Loader2 size={20} className="animate-spin text-gray-300" />
    </div>
  )
}

function EmptyState({ icon, title, subtitle }: {
  icon:     React.ReactNode
  title:    string
  subtitle: string
}) {
  return (
    <div className="flex flex-col items-center justify-center py-14 text-center">
      <div className="mb-3">{icon}</div>
      <p className="text-sm font-medium text-gray-500">{title}</p>
      <p className="text-xs text-gray-400 mt-1">{subtitle}</p>
    </div>
  )
}
