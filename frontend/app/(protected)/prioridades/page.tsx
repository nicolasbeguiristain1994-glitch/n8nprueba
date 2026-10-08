'use client'
import { PriorityBroadcastComposer, broadcastRequest, type BroadcastContact } from '@/components/priorities/PriorityBroadcastComposer'
import { PriorityBroadcastProgress } from '@/components/priorities/PriorityBroadcastProgress'
import { PageHeader } from '@/components/layout/PageHeader'
import { useEffect, useState, useCallback, useRef } from 'react'
import {
  TrendingUp, RefreshCw, ChevronLeft, ChevronRight,
  Filter, AlertCircle, Send, RotateCcw, HelpCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { fetchJson } from '@/lib/fetchJson'
import { useCurrentUser } from '@/lib/useCurrentUser'

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface PrioritizedContact {
  id:                  string
  phoneNumber:         string
  firstName:           string | null
  lastName:            string | null
  segment:             string | null
  platforms:           string[]
  agent:               string | null
  lastDepositAt:       string | null
  totalDepositAmount:  number | null
  priorityScore:       number
  reactivationSegment: string | null
  valueTier:           string
  daysInactive:        number | null
  daysSinceLastMessage: number | null
  broadcastState?:     string | null
  broadcastBusy?:      boolean
  isBroadcasted:       boolean
  broadcastedAt:       string | null
  broadcastedBy:       string | null
  ltvScore:            number | null
  ltvTier:             string | null
}

interface PaginatedResult {
  data:       PrioritizedContact[]
  total:      number
  page:       number
  pageSize:   number
  totalPages: number
  computedAt?: string | null
  recomputing?: boolean
}

interface RecomputeResult {
  processed:  number
  eligible:   number
  skipped:    number
  durationMs: number
}

type Tab      = 'pending' | 'broadcasted'
type Platform = 'todas' | 'zeus' | 'bet30' | 'ganamos' | 'argenbet'

// ── Constantes de UI ──────────────────────────────────────────────────────────

const SEGMENT_LABEL: Record<string, string> = {
  REACTIVACION_URGENTE:         'Urgente',
  REACTIVACION_PRIORITARIA:     'Prioritaria',
  REACTIVACION_ESTANDAR:        'Estándar',
  REACTIVACION_FRIA_ALTO_VALOR: 'Fría alto valor',
  REACTIVACION_FRIA:            'Fría',
}

const SEGMENT_STYLE: Record<string, string> = {
  REACTIVACION_URGENTE:         'bg-destructive/15 text-destructive',
  REACTIVACION_PRIORITARIA:     'bg-orange-100 text-orange-700',
  REACTIVACION_ESTANDAR:        'bg-blue-100 text-blue-700',
  REACTIVACION_FRIA_ALTO_VALOR: 'bg-purple-100 text-purple-700',
  REACTIVACION_FRIA:            'bg-muted text-muted-foreground',
}

const TIER_STYLE: Record<string, string> = {
  super_vip: 'bg-purple-100 text-purple-700',
  vip_alto:  'bg-warning/15 text-warning',
  vip_medio: 'bg-warning/10 text-amber-600',
  vip:       'bg-yellow-100 text-yellow-700',
  medio:     'bg-blue-100 text-blue-700',
  bajo:      'bg-muted text-muted-foreground',
}

const TIER_LABEL: Record<string, string> = {
  super_vip: 'Super Vip',
  vip_alto:  'Vip Alto',
  vip_medio: 'Vip Medio',
  vip:       'Vip',
  medio:     'Medio',
  bajo:      'Bajo',
}

const AGENTS: string[] = ['betcoin', 'bigwin', 'farabet', 'ofizeus', 'royal', 'lasvegas', 'imperio']

const PLATFORMS: { key: Platform; label: string }[] = [
  { key: 'todas', label: 'Todas' },
  { key: 'zeus',  label: 'Zeus' },
  { key: 'bet30', label: 'Bet30' },
  { key: 'ganamos', label: 'Ganamos' },
  { key: 'argenbet', label: 'Argenbet' },
]

const PAGE_SIZE = 50

// ── Modal de ayuda ────────────────────────────────────────────────────────────

function ScoringHelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
    <DialogContent className="max-w-xl">
      <DialogHeader><DialogTitle>Cómo se calculan las prioridades</DialogTitle></DialogHeader>
      <div className="space-y-3 text-sm text-muted-foreground">
        <p>El puntaje suma valor (hasta 60 puntos) y urgencia (hasta 40 puntos).</p>
        <p>Cuando hay LTV disponible, se usa su nivel y puntaje. En los demás casos se usan el monto o nivel registrado y la configuración de segmentación vigente.</p>
        <p>La urgencia disminuye a medida que pasan los días dentro de la ventana configurada para ese nivel. Se toma la fecha de actividad más reciente disponible entre los movimientos importados y el historial del contacto.</p>
        <p>Se excluyen contactos borrados, bloqueados, sin consentimiento, fuera de su ventana o contactados recientemente. Los permisos del operador también limitan la lista.</p>
        <p>La fecha del último cálculo indica cuándo se generó la lista. Los movimientos disponibles dependen de la última sincronización de cada plataforma.</p>
        <p>Seleccioná contactos, elegí una plantilla aprobada y confirmá el envío. Sólo los envíos confirmados por WhatsApp pasan automáticamente a Difundidos. Los fallidos permanecen para revisión y reintento en la misma difusión.</p>
      </div>
    </DialogContent>
  </Dialog>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function contactName(c: PrioritizedContact) {
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || '—'
}

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

// ── Componente ────────────────────────────────────────────────────────────────

export default function PrioridadesPage() {
  const { user, permissions } = useCurrentUser()
  const isAdmin  = user?.role === 'admin'

  const canSend = isAdmin || (!!permissions.contacts?.includes('read') && !!permissions.campaigns?.includes('create') && !!permissions.send?.includes('send'))
  const canReadCampaigns = isAdmin || !!permissions.campaigns?.includes('read')
  const canManageCampaigns = isAdmin || !!permissions.campaigns?.includes('update')
  const [selected, setSelected] = useState<Map<string,BroadcastContact>>(new Map())
  const [compose, setCompose] = useState<BroadcastContact[]|null>(null)
  const [broadcastVersion, setBroadcastVersion] = useState(0)
  const [broadcastNotice, setBroadcastNotice] = useState<string|null>(null)

  const [tab, setTab]                     = useState<Tab>('pending')
  const [platform, setPlatform]           = useState<Platform>('todas')
  const [result, setResult]               = useState<PaginatedResult | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const loadSequence = useRef(0)
  const [loading, setLoading]             = useState(false)
  const [recomputing, setRecomputing]     = useState(false)
  const [recomputeMsg, setRecomputeMsg]   = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [page, setPage]                   = useState(1)
  const [segment, setSegment]             = useState('todos')
  const [tier, setTier]                   = useState('todos')
  const [agent, setAgent]                 = useState('todos')
  const [showHelp, setShowHelp]           = useState(false)

  const load = useCallback(async (
    p   = page,
    seg = segment,
    tr  = tier,
    ag  = agent,
    plt = platform,
    t   = tab,
  ) => {
    const sequence = ++loadSequence.current
    setLoading(true); setLoadError(null)
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) })
      if (t === 'broadcasted') params.set('broadcasted', 'true')
      if (seg !== 'todos') params.set('reactivationSegment', seg)
      if (tr  !== 'todos') params.set('valueTier', tr)
      if (ag  !== 'todos') params.set('agent', ag)
      if (plt !== 'todas') params.set('platform', plt)
      const data = await fetchJson<PaginatedResult>(`/api/contacts/prioritized?${params}`)
      if (sequence === loadSequence.current) {
        setResult(data)
        setSelected(old=>{const next=new Map(old);data.data.forEach(c=>{if(c.broadcastBusy||c.isBroadcasted)next.delete(c.id)});return next})
        if(!data.data.length&&data.total>0&&p>data.totalPages)setPage(Math.max(1,data.totalPages))
      }
    } catch (err) {
      if (sequence === loadSequence.current) {
        setResult(null); setLoadError(err instanceof Error ? err.message : 'No se pudieron cargar las prioridades')
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false)
    }
  }, [page, segment, tier, agent, platform, tab, refreshVersion])

  useEffect(() => { void load(); return () => { loadSequence.current++ } }, [load])

  const switchTab = (t: Tab) => {
    setSelected(new Map()); setTab(t); setPage(1)
  }

  const switchPlatform = (plt: Platform) => {
    setSelected(new Map()); setPlatform(plt); setPage(1)
  }

  const handleFilter = (newSeg: string, newTier: string, newAgent: string) => {
    setSelected(new Map()); setPage(1); setSegment(newSeg); setTier(newTier); setAgent(newAgent)
  }

  const handleRecompute = async () => {
    setRecomputing(true); setRecomputeMsg(null)
    try {
      const res = await fetchJson<RecomputeResult>('/api/contacts/recompute-priorities', { method: 'POST' })
      setRecomputeMsg({
        type: 'ok',
        text: `Recompute completado: ${res.eligible} elegibles de ${res.processed} contactos (${(res.durationMs / 1000).toFixed(1)}s)`,
      })
      setPage(1); setRefreshVersion(v => v + 1)
    } catch (err) {
      setRecomputeMsg({ type: 'error', text: err instanceof Error ? err.message : 'Error al recomputar' })
    } finally {
      setRecomputing(false)
    }
  }

  const toggleBroadcasted = async (contactId: string, markAs: boolean) => {
    setPendingAction(contactId); setActionError(null)
    try {
      await fetchJson(`/api/contacts/prioritized/${contactId}/broadcast`, {
        method: 'PATCH',
        body: JSON.stringify({ broadcasted: markAs }),
      })
      setPage(1); setRefreshVersion(v => v + 1)
      setPage(1)
    } catch (err) { setActionError(err instanceof Error ? err.message : 'No se pudo guardar el cambio') } finally {
      setPendingAction(null)
    }
  }

  useEffect(()=>{if(!canSend){setSelected(new Map());setCompose(null)}},[canSend])
  const eligiblePage = (result?.data??[]).filter(c=>!c.broadcastBusy&&!c.isBroadcasted)
  const allSelected = eligiblePage.length>0&&eligiblePage.every(c=>selected.has(c.id))
  const toggleSelection=(contact:BroadcastContact)=>{
    setSelected(old=>{const next=new Map(old);if(next.has(contact.id))next.delete(contact.id);else if(next.size<200)next.set(contact.id,contact);return next})
  }
  const selectPage=()=>setSelected(old=>{
    const next=new Map(old);eligiblePage.forEach(c=>{if(allSelected)next.delete(c.id);else if(next.size<200)next.set(c.id,c)});return next
  })
  const refreshBroadcasts=useCallback(()=>setRefreshVersion(v=>v+1),[])
  async function startBroadcast(id:string) {
    setCompose(null);setSelected(new Map());setBroadcastNotice('Difusión preparada. Iniciando envío…');setActionError(null)
    try {
      await broadcastRequest(`/api/campaigns/${id}/dispatch`)
      setBroadcastNotice('Difusión iniciada. Podés seguir trabajando; el progreso se actualiza aquí.')
    } catch(e) {
      setBroadcastNotice(null);setActionError(`${e instanceof Error?e.message:'No se pudo iniciar el envío'}. La selección quedó guardada en Mis difusiones; podés continuar desde allí.`)
    } finally {setBroadcastVersion(v=>v+1);setRefreshVersion(v=>v+1)}
  }

  const hasFilters = segment !== 'todos' || tier !== 'todos' || agent !== 'todos'

  return (
    <div className="flex min-w-0 flex-col gap-4">

      {compose&&canSend&&<PriorityBroadcastComposer contacts={compose} onClose={()=>{setCompose(null);setBroadcastVersion(v=>v+1)}} onPrepared={id=>void startBroadcast(id)} />}
      <ScoringHelpModal open={showHelp} onClose={() => setShowHelp(false)} />

      {/* Header */}
      <div>
        <PageHeader title="Prioridades" className="mb-0" count={result?.total}
          description={`Contactos ordenados por score de reactivación · ${tab === 'pending' ? 'A difundir' : 'Difundidos'}`}>
          <Button variant="outline" size="sm" onClick={() => setShowHelp(true)} className="gap-2">
            <HelpCircle size={16} /> Cómo funciona
          </Button>
          {isAdmin && (
            <Button onClick={handleRecompute} disabled={recomputing || result?.recomputing} size="sm" variant="outline" className="gap-2">
              <RefreshCw size={14} className={recomputing ? 'animate-spin' : ''} />
              {recomputing ? 'Calculando…' : 'Recomputar'}
            </Button>
          )}
        </PageHeader>
        {recomputeMsg && (
          <div className={`mt-3 flex items-center gap-2 text-sm px-3 py-2 rounded-lg ${
            recomputeMsg.type === 'ok' ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'
          }`}>
            <AlertCircle size={14} />
            {recomputeMsg.text}
          </div>
        )}
      </div>

      {result && <div className="text-sm text-muted-foreground">
        Último cálculo: {result.computedAt ? new Date(result.computedAt).toLocaleString('es-AR') : 'sin cálculo completo'}
        {result.recomputing && <span className="ml-3">Actualización en curso; se muestra el último cálculo completo.</span>}
        {result.computedAt && Date.now() - Date.parse(result.computedAt) > 36 * 3600000 && <span className="ml-3 text-warning">El cálculo tiene más de 36 horas. Actualizalo para incorporar movimientos recientes.</span>}
      </div>}
      {actionError && <p role="alert" className="rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive">{actionError}</p>}

      {broadcastNotice&&<p role="status" className="rounded-xl bg-primary/10 p-3 text-sm text-primary">{broadcastNotice}</p>}
      {canReadCampaigns&&<PriorityBroadcastProgress version={broadcastVersion} onChanged={refreshBroadcasts} canSend={canSend} canManage={canManageCampaigns} />}

      {/* Tab principal: A difundir / Difundidos */}
      <div className="flex w-fit max-w-full gap-1 rounded-xl border border-border bg-card p-1">
        {([
          { key: 'pending',     label: 'A difundir' },
          { key: 'broadcasted', label: 'Difundidos' },
        ] as { key: Tab; label: string }[]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => switchTab(key)}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              tab === key
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab de plataforma */}
      <div className="filter-bar">
        <span className="text-xs text-muted-foreground mr-1 shrink-0">Plataforma:</span>
        {PLATFORMS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => switchPlatform(key)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors shrink-0 ${
              platform === key
                ? 'bg-primary/10 text-primary'
                : 'bg-muted text-muted-foreground hover:bg-border'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Filtros: segmento, nivel, agente */}
      <div className="filter-bar gap-4">
        <Filter size={14} className="text-muted-foreground shrink-0" />

        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground shrink-0">Segmento:</span>
          <Select value={segment} onValueChange={v => handleFilter(v ?? 'todos', tier, agent)}>
            <SelectTrigger className="w-40 h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos</SelectItem>
              <SelectItem value="REACTIVACION_URGENTE">Urgente</SelectItem>
              <SelectItem value="REACTIVACION_PRIORITARIA">Prioritaria</SelectItem>
              <SelectItem value="REACTIVACION_ESTANDAR">Estándar</SelectItem>
              <SelectItem value="REACTIVACION_FRIA_ALTO_VALOR">Fría alto valor</SelectItem>
              <SelectItem value="REACTIVACION_FRIA">Fría</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground shrink-0">Nivel:</span>
          <Select value={tier} onValueChange={v => handleFilter(segment, v ?? 'todos', agent)}>
            <SelectTrigger className="w-28 h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos</SelectItem>
              <SelectItem value="super_vip">Super Vip</SelectItem>
              <SelectItem value="vip_alto">Vip Alto</SelectItem>
              <SelectItem value="vip_medio">Vip Medio</SelectItem>
              <SelectItem value="vip">Vip</SelectItem>
              <SelectItem value="medio">Medio</SelectItem>
              <SelectItem value="bajo">Bajo</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground shrink-0">Agente:</span>
          <Select value={agent} onValueChange={v => handleFilter(segment, tier, v ?? 'todos')}>
            <SelectTrigger className="w-32 h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos</SelectItem>
              {AGENTS.map(a => (
                <SelectItem key={a} value={a}>{a}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {hasFilters && (
          <button
            onClick={() => handleFilter('todos', 'todos', 'todos')}
            className="text-xs text-muted-foreground hover:text-muted-foreground underline"
          >
            Limpiar filtros
          </button>
        )}
      </div>

      {tab==='pending'&&canSend&&<div className="surface sticky top-0 z-10 flex flex-wrap items-center gap-3 p-3 shadow-sm">
        <Button variant="outline" size="sm" onClick={selectPage} disabled={loading||!eligiblePage.length}>{allSelected?'Quitar selección de página':'Seleccionar esta página'}</Button>
        <span className="text-sm text-muted-foreground" role="status">{selected.size} seleccionados · máximo 200</span>
        {selected.size>0&&<button className="text-sm underline text-muted-foreground" onClick={()=>setSelected(new Map())}>Limpiar selección</button>}
        <Button className="gap-2 sm:ml-auto" disabled={!selected.size||loading} onClick={()=>setCompose([...selected.values()])}><Send size={16}/> Difundir seleccionados {selected.size>0?`(${selected.size})`:''}</Button>
        <p className="basis-full text-xs text-muted-foreground">La selección se conserva al cambiar de página y se limpia al cambiar los filtros. Los contactos con una difusión pendiente se gestionan desde Mis difusiones.</p>
      </div>}

      {/* Tabla */}
      <div className="min-w-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
            <RefreshCw size={16} className="animate-spin mr-2" /> Cargando…
          </div>
        ) : loadError ? (
          <div role="alert" className="p-6 text-center text-destructive">
            <p>{loadError}</p>
            <Button variant="outline" className="mt-3" onClick={() => setRefreshVersion(v => v + 1)}>Reintentar</Button>
          </div>
        ) : !result || result.data.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center gap-3">
            <TrendingUp size={32} className="text-muted-foreground/60" />
            {tab === 'pending' ? (
              <>
                <p className="text-muted-foreground text-sm font-medium">No hay contactos a difundir</p>
                <p className="text-muted-foreground text-xs max-w-sm">
                  {hasFilters || platform !== 'todas'
                    ? 'No hay resultados con estos filtros. Probá ampliarlos.'
                    : isAdmin && !result?.computedAt
                    ? 'Hacé clic en "Recomputar" para calcular las prioridades.'
                    : 'Aún no hay contactos priorizados.'}
                </p>
              </>
            ) : (
              <>
                <p className="text-muted-foreground text-sm font-medium">Aún no hay contactos difundidos</p>
                <p className="text-muted-foreground text-xs max-w-sm">
                  Los contactos aparecen aquí automáticamente cuando se confirma el envío desde "A difundir".
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="surface overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-xs font-semibold text-muted-foreground">
                  {tab==='pending'&&canSend&&<th className="px-3 py-3 w-10"><input type="checkbox" aria-label="Seleccionar contactos de esta página" checked={allSelected} onChange={selectPage} disabled={!eligiblePage.length} className="h-4 w-4 accent-primary" /></th>}
                  <th className="px-4 py-3 text-right w-16">Score</th>
                  <th className="px-4 py-3 text-left">Contacto</th>
                  <th className="px-4 py-3 text-left w-24">Agente</th>
                  <th className="px-4 py-3 text-left">Segmento</th>
                  <th className="px-4 py-3 text-left w-24">Nivel</th>
                  <th className="px-4 py-3 text-right w-20">LTV</th>
                  <th className="px-4 py-3 text-right w-28">Días inactivo</th>
                  <th className="px-4 py-3 text-left">Plataformas</th>
                  {tab === 'broadcasted' && (
                    <th className="px-4 py-3 text-left w-32">Difundido</th>
                  )}
                  <th className="px-4 py-3 w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.data.map(c => (
                  <tr key={c.id} className={selected.has(c.id)?'bg-primary/5':'hover:bg-background transition-colors'}>
                    {tab==='pending'&&canSend&&<td className="px-3 py-3"><input type="checkbox" aria-label={`Seleccionar ${contactName(c)}`} checked={selected.has(c.id)} onChange={()=>toggleSelection(c)} disabled={!!c.broadcastBusy||(!selected.has(c.id)&&selected.size>=200)} className="h-4 w-4 accent-primary" /></td>}
                    <td className="px-4 py-3 text-right">
                      <span className="font-semibold text-foreground tabular-nums">
                        {Math.round(c.priorityScore)}
                      </span>
                    </td>

                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{contactName(c)}</div>
                      <div className="text-xs text-muted-foreground">{c.phoneNumber}</div>
                      {tab==='pending'&&c.broadcastState&&c.broadcastState!=='cancelled'&&c.broadcastState!=='sent'&&<span className="mt-1 inline-flex rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{{pending:'En difusión',failed:'Falló · revisar difusión',skipped:'Omitido · revisar difusión',review:'Pendiente de confirmación'}[c.broadcastState]||'Revisar difusión'}</span>}
                    </td>

                    <td className="px-4 py-3">
                      {c.agent
                        ? <span className="text-xs font-medium text-foreground capitalize">{c.agent}</span>
                        : <span className="text-muted-foreground/60 text-xs">—</span>
                      }
                    </td>

                    <td className="px-4 py-3">
                      {c.reactivationSegment ? (
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${SEGMENT_STYLE[c.reactivationSegment] ?? 'bg-muted text-muted-foreground'}`}>
                          {SEGMENT_LABEL[c.reactivationSegment] ?? c.reactivationSegment}
                        </span>
                      ) : <span className="text-muted-foreground/60">—</span>}
                    </td>

                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${TIER_STYLE[c.valueTier] ?? 'bg-muted text-muted-foreground'}`}>
                        {TIER_LABEL[c.valueTier] ?? c.valueTier}
                      </span>
                    </td>

                    <td className="px-4 py-3 text-right">
                      {c.ltvScore != null ? (
                        <span
                          title={`LTV Tier: ${TIER_LABEL[c.ltvTier ?? ''] ?? c.ltvTier ?? '—'}`}
                          className={`inline-flex items-center justify-center w-8 h-6 rounded text-xs font-semibold tabular-nums ${TIER_STYLE[c.ltvTier ?? ''] ?? 'bg-muted text-muted-foreground'}`}
                        >
                          {c.ltvScore}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/60 text-xs">—</span>
                      )}
                    </td>

                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {c.daysInactive != null ? `${c.daysInactive}d` : '—'}
                    </td>

                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {c.platforms.length > 0
                          ? c.platforms.map(p => (
                              <span key={p} className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                                {p}
                              </span>
                            ))
                          : <span className="text-muted-foreground/60 text-xs">—</span>
                        }
                      </div>
                    </td>

                    {tab === 'broadcasted' && (
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        <div>{formatDate(c.broadcastedAt)}</div>
                        {c.broadcastedBy && (
                          <div className="text-muted-foreground">{c.broadcastedBy}</div>
                        )}
                      </td>
                    )}

                    <td className="px-4 py-3 text-right">
                      {tab==='pending' ? (canSend&&<Button size="sm" variant="outline" className="gap-2" disabled={!!c.broadcastBusy} onClick={()=>setCompose([c])}><Send size={14}/> Difundir</Button>) : isAdmin&&(
                        <button onClick={()=>toggleBroadcasted(c.id,false)} disabled={pendingAction===c.id} title="Volver a A difundir" aria-label={`Volver a difundir a ${contactName(c)}`} className="p-1.5 rounded-lg text-muted-foreground hover:text-amber-600 hover:bg-warning/10 disabled:opacity-40">
                          {pendingAction===c.id?<RefreshCw size={14} className="animate-spin"/>:<RotateCcw size={14}/>}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Paginación */}
      {result && result.totalPages > 1 && (
        <div className="surface flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm text-muted-foreground">
          <span>
            {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, result.total)} de {result.total.toLocaleString()}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setPage(p => p - 1) }}
              disabled={page <= 1}
              className="p-1 rounded hover:bg-muted disabled:opacity-30"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-xs">Pág. {page} de {result.totalPages}</span>
            <button
              onClick={() => { setPage(p => p + 1) }}
              disabled={page >= result.totalPages}
              className="p-1 rounded hover:bg-muted disabled:opacity-30"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
