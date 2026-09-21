'use client'

import * as React from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Plus, Download, Trash2, Copy, ExternalLink, Loader2, Search } from 'lucide-react'
import { Dashboard } from './Dashboard'

interface EncuestaListRow {
  id: string; slug: string; title: string; description: string | null
  is_active: boolean; created_at: string; updated_at: string
  questions_count: number; respuestas_count: number
}

interface RespuestaRow {
  id: string
  answers: Record<string, unknown>
  username: string
  email: string | null
  campaign: string | null
  source: string | null
  player_token: string | null
  submitted_at: string
}

interface EncuestaDetail extends EncuestaListRow {
  questions: unknown[]
}

const EMPTY_QUESTIONS = [
  { id: 'q1', type: 'rating', label: '¿Cómo calificás tu experiencia?', required: true },
]

export default function EncuestasAdminPage() {
  const [rows, setRows]         = React.useState<EncuestaListRow[]>([])
  const [loading, setLoading]   = React.useState(true)
  const [editing, setEditing]   = React.useState<EncuestaDetail | null>(null)
  const [showEditor, setShowEditor] = React.useState(false)
  const [respuestasFor, setRespuestasFor] = React.useState<EncuestaListRow | null>(null)

  async function reload() {
    setLoading(true)
    const res = await fetch('/api/encuestas', { cache: 'no-store' })
    const data = await res.json()
    setRows(data.encuestas ?? [])
    setLoading(false)
  }

  React.useEffect(() => { void reload() }, [])

  async function openEditor(id: string | null) {
    if (!id) {
      setEditing({
        id: '', slug: '', title: '', description: '',
        is_active: true, created_at: '', updated_at: '',
        questions_count: 0, respuestas_count: 0,
        questions: EMPTY_QUESTIONS,
      })
    } else {
      const res = await fetch(`/api/encuestas/${id}`, { cache: 'no-store' })
      if (!res.ok) return alert('No se pudo cargar la encuesta')
      const data = await res.json()
      setEditing({ ...data, respuestas_count: 0, questions_count: data.questions?.length ?? 0 })
    }
    setShowEditor(true)
  }

  async function deleteEncuesta(id: string) {
    if (!confirm('¿Eliminar la encuesta y todas sus respuestas? Esta acción no se puede deshacer.')) return
    const res = await fetch(`/api/encuestas/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const b = await res.json().catch(() => null)
      return alert(b?.error ?? 'No se pudo eliminar')
    }
    void reload()
  }

  function copyLink(slug: string) {
    const url = `${window.location.origin}/encuesta?slug=${slug}`
    navigator.clipboard.writeText(url).then(
      () => alert('Link copiado'),
      () => alert('No se pudo copiar. URL: ' + url),
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-heading text-2xl font-medium">Encuestas</h1>
          <p className="text-sm text-muted-foreground">Creá encuestas para compartir por el estado de WhatsApp u otros canales.</p>
        </div>
        <Button onClick={() => openEditor(null)}>
          <Plus />
          Nueva encuesta
        </Button>
      </div>

      {loading ? (
        <Card><CardContent className="py-8 flex justify-center"><Loader2 className="animate-spin" /></CardContent></Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No hay encuestas todavía. Creá la primera.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {rows.map(r => (
            <Card key={r.id}>
              <CardContent className="py-4 flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <button
                      className="font-medium truncate text-left hover:underline"
                      onClick={() => openEditor(r.id)}
                    >
                      {r.title}
                    </button>
                    {r.is_active
                      ? <Badge variant="default">Activa</Badge>
                      : <Badge variant="secondary">Inactiva</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 truncate">
                    /encuesta?slug={r.slug} · {r.questions_count} preguntas · {r.respuestas_count} respuestas
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon-sm" onClick={() => copyLink(r.slug)} aria-label="Copiar link">
                    <Copy />
                  </Button>
                  <Link href={`/encuesta?slug=${r.slug}`} target="_blank" rel="noopener noreferrer">
                    <Button variant="ghost" size="icon-sm" aria-label="Abrir">
                      <ExternalLink />
                    </Button>
                  </Link>
                  <Button variant="outline" size="sm" onClick={() => setRespuestasFor(r)}>
                    Respuestas
                  </Button>
                  <Button variant="destructive" size="icon-sm" onClick={() => deleteEncuesta(r.id)} aria-label="Eliminar">
                    <Trash2 />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {showEditor && editing ? (
        <EditorDialog
          value={editing}
          onClose={() => setShowEditor(false)}
          onSaved={() => { setShowEditor(false); void reload() }}
        />
      ) : null}

      {respuestasFor ? (
        <RespuestasDialog
          encuesta={respuestasFor}
          onClose={() => setRespuestasFor(null)}
        />
      ) : null}
    </div>
  )
}

// ── Editor ───────────────────────────────────────────────────────────────────

function EditorDialog({
  value, onClose, onSaved,
}: {
  value: EncuestaDetail
  onClose: () => void
  onSaved: () => void
}) {
  const isNew = !value.id
  const [slug, setSlug]                 = React.useState(value.slug)
  const [title, setTitle]               = React.useState(value.title)
  const [description, setDescription]   = React.useState(value.description ?? '')
  const [isActive, setIsActive]         = React.useState(value.is_active)
  const [questionsJson, setQuestionsJson] = React.useState<string>(
    JSON.stringify(value.questions, null, 2),
  )
  const [saving, setSaving] = React.useState(false)
  const [error, setError]   = React.useState<string | null>(null)

  async function save() {
    setError(null)
    let questions: unknown
    try {
      questions = JSON.parse(questionsJson)
    } catch {
      setError('El JSON de preguntas no es válido')
      return
    }
    setSaving(true)
    const body = { slug, title, description: description || null, questions, is_active: isActive }
    const res = await fetch(isNew ? '/api/encuestas' : `/api/encuestas/${value.id}`, {
      method: isNew ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setSaving(false)
    if (!res.ok) {
      const b = await res.json().catch(() => null)
      setError(b?.error ?? 'No se pudo guardar')
      return
    }
    onSaved()
  }

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Nueva encuesta' : 'Editar encuesta'}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Slug (para el link)</label>
            <Input
              value={slug}
              onChange={e => setSlug(e.target.value.toLowerCase())}
              placeholder="wa-status-julio"
              maxLength={64}
            />
            <p className="text-xs text-muted-foreground">Solo minúsculas, dígitos y guiones. URL final: /encuesta?slug={slug || '…'}</p>
          </div>

          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Título</label>
            <Input value={title} onChange={e => setTitle(e.target.value)} maxLength={120} />
          </div>

          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Descripción</label>
            <Textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              maxLength={500}
              rows={2}
            />
          </div>

          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Preguntas (JSON)</label>
            <Textarea
              value={questionsJson}
              onChange={e => setQuestionsJson(e.target.value)}
              rows={14}
              className="font-mono text-xs"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Formato: <code>{`{ id, type: 'rating'|'multiple'|'text'|'select', label, options?, required? }`}</code>
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={e => setIsActive(e.target.checked)}
              className="size-4 rounded border-input"
            />
            Activa (visible en /encuesta cuando es la última creada)
          </label>

          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            Guardar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Respuestas + export ──────────────────────────────────────────────────────

function RespuestasDialog({
  encuesta, onClose,
}: {
  encuesta: EncuestaListRow
  onClose: () => void
}) {
  const [rows, setRows]     = React.useState<RespuestaRow[]>([])
  const [total, setTotal]   = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [from, setFrom]     = React.useState('')
  const [to, setTo]         = React.useState('')
  const [campaign, setCampaign] = React.useState('')
  const [username, setUsername] = React.useState('')
  // Copia congelada que sólo se actualiza al hacer "Aplicar filtros" o Enter en
  // el buscador — evita disparar N requests al tipear.
  const [appliedFilters, setAppliedFilters] = React.useState({
    from: '', to: '', campaign: '', username: '',
  })

  const load = React.useCallback(async () => {
    setLoading(true)
    const p = new URLSearchParams()
    if (appliedFilters.from)     p.set('from',     new Date(appliedFilters.from).toISOString())
    if (appliedFilters.to)       p.set('to',       new Date(appliedFilters.to).toISOString())
    if (appliedFilters.campaign.trim()) p.set('campaign', appliedFilters.campaign.trim())
    if (appliedFilters.username.trim()) p.set('username', appliedFilters.username.trim())
    p.set('limit', '200')
    const res = await fetch(`/api/encuestas/${encuesta.id}/respuestas?${p.toString()}`, { cache: 'no-store' })
    const data = await res.json()
    setRows(data.respuestas ?? [])
    setTotal(data.total ?? 0)
    setLoading(false)
  }, [encuesta.id, appliedFilters])

  React.useEffect(() => { void load() }, [load])

  function applyFilters() {
    setAppliedFilters({ from, to, campaign, username })
  }

  function exportCsv() {
    const p = new URLSearchParams()
    if (appliedFilters.from)     p.set('from',     new Date(appliedFilters.from).toISOString())
    if (appliedFilters.to)       p.set('to',       new Date(appliedFilters.to).toISOString())
    if (appliedFilters.campaign.trim()) p.set('campaign', appliedFilters.campaign.trim())
    if (appliedFilters.username.trim()) p.set('username', appliedFilters.username.trim())
    window.location.href = `/api/encuestas/${encuesta.id}/respuestas/export?${p.toString()}`
  }

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Respuestas — {encuesta.title}</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="dashboard" className="flex-1 overflow-hidden flex flex-col">
          <TabsList>
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
            <TabsTrigger value="lista">Respuestas</TabsTrigger>
            <TabsTrigger value="filtros">Filtros</TabsTrigger>
          </TabsList>

          <TabsContent value="filtros" className="pt-4 grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1">
                <label className="text-xs font-medium">Desde</label>
                <Input type="date" value={from} onChange={e => setFrom(e.target.value)} />
              </div>
              <div className="grid gap-1">
                <label className="text-xs font-medium">Hasta</label>
                <Input type="date" value={to} onChange={e => setTo(e.target.value)} />
              </div>
            </div>
            <div className="grid gap-1">
              <label className="text-xs font-medium">Campaign (exact)</label>
              <Input value={campaign} onChange={e => setCampaign(e.target.value)} placeholder="wa_status_julio" />
            </div>
            <div className="grid gap-1">
              <label className="text-xs font-medium">Username (búsqueda parcial)</label>
              <Input
                value={username}
                onChange={e => setUsername(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') applyFilters() }}
                placeholder="pepe123"
              />
            </div>
            <p className="text-[11px] text-muted-foreground">Los filtros se aplican al dashboard, al listado y al CSV.</p>
          </TabsContent>

          <TabsContent value="dashboard" className="pt-4 flex-1 overflow-auto">
            <Dashboard encuestaId={encuesta.id} filters={appliedFilters} />
          </TabsContent>

          <TabsContent value="lista" className="pt-4 flex-1 overflow-auto">
            <div className="flex items-center gap-2 mb-3">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                <Input
                  className="pl-7"
                  placeholder="Buscar por username y Enter"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') applyFilters() }}
                />
              </div>
              <Button variant="outline" size="sm" onClick={applyFilters}>Aplicar</Button>
            </div>

            {loading ? (
              <div className="py-8 flex justify-center"><Loader2 className="animate-spin" /></div>
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                Sin respuestas para los filtros actuales.
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">Total: {total}</p>
                {rows.map(r => (
                  <Card key={r.id} size="sm">
                    <CardContent className="text-xs space-y-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="default" className="font-mono text-[11px]">@{r.username}</Badge>
                        <span className="tabular-nums text-muted-foreground">
                          {new Date(r.submitted_at).toLocaleString('es-AR')}
                        </span>
                        {r.email ? <Badge variant="outline" className="text-[11px]">{r.email}</Badge> : null}
                        {r.campaign ? <Badge variant="secondary">{r.campaign}</Badge> : null}
                        {r.source ? <Badge variant="outline">{r.source}</Badge> : null}
                      </div>
                      <pre className="text-[11px] whitespace-pre-wrap break-words bg-muted/40 rounded p-2">
                        {JSON.stringify(r.answers, null, 2)}
                      </pre>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>

        <div className="flex justify-end gap-2 pt-2 border-t mt-2">
          <Button variant="ghost" onClick={onClose}>Cerrar</Button>
          <Button variant="outline" onClick={applyFilters}>Aplicar filtros</Button>
          <Button onClick={exportCsv}>
            <Download />
            Exportar CSV
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
