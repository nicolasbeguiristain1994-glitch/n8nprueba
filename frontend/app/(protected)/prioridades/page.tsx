'use client'
import { useEffect, useState, useCallback } from 'react'
import {
  TrendingUp, RefreshCw, ChevronLeft, ChevronRight,
  Filter, AlertCircle, CheckCircle2, RotateCcw, HelpCircle,
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
}

interface RecomputeResult {
  processed:  number
  eligible:   number
  skipped:    number
  durationMs: number
}

type Tab      = 'pending' | 'broadcasted'
type Platform = 'todas' | 'zeus' | 'bet30'

// ── Constantes de UI ──────────────────────────────────────────────────────────

const SEGMENT_LABEL: Record<string, string> = {
  REACTIVACION_URGENTE:         'Urgente',
  REACTIVACION_PRIORITARIA:     'Prioritaria',
  REACTIVACION_ESTANDAR:        'Estándar',
  REACTIVACION_FRIA_ALTO_VALOR: 'Fría alto valor',
  REACTIVACION_FRIA:            'Fría',
}

const SEGMENT_STYLE: Record<string, string> = {
  REACTIVACION_URGENTE:         'bg-red-100 text-red-700',
  REACTIVACION_PRIORITARIA:     'bg-orange-100 text-orange-700',
  REACTIVACION_ESTANDAR:        'bg-blue-100 text-blue-700',
  REACTIVACION_FRIA_ALTO_VALOR: 'bg-purple-100 text-purple-700',
  REACTIVACION_FRIA:            'bg-gray-100 text-gray-600',
}

const TIER_STYLE: Record<string, string> = {
  super_vip: 'bg-purple-100 text-purple-700',
  vip_alto:  'bg-amber-100 text-amber-700',
  vip_medio: 'bg-amber-50 text-amber-600',
  vip:       'bg-yellow-100 text-yellow-700',
  medio:     'bg-blue-100 text-blue-700',
  bajo:      'bg-gray-100 text-gray-500',
}

const TIER_LABEL: Record<string, string> = {
  super_vip: 'Super Vip',
  vip_alto:  'Vip Alto',
  vip_medio: 'Vip Medio',
  vip:       'Vip',
  medio:     'Medio',
  bajo:      'Bajo',
}

const AGENTS: string[] = ['betcoin', 'bigwin', 'farabet', 'ofizeus', 'royal', 'lasvegas']

const PLATFORMS: { key: Platform; label: string }[] = [
  { key: 'todas', label: 'Todas' },
  { key: 'zeus',  label: 'Zeus' },
  { key: 'bet30', label: 'Bet30' },
]

const PAGE_SIZE = 50

// ── Modal de ayuda ────────────────────────────────────────────────────────────

function ScoringHelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <TrendingUp size={18} className="text-green-600" />
            ¿Cómo funciona el score de prioridades?
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 text-sm text-gray-700">

          {/* Fórmula */}
          <div className="bg-gray-50 rounded-lg px-4 py-3 text-center">
            <p className="text-xs text-gray-400 mb-1">Fórmula del score</p>
            <p className="font-mono text-gray-800 text-base">
              Score (0–100) = <span className="text-purple-600 font-semibold">Valor</span> + <span className="text-amber-600 font-semibold">Urgencia</span>
            </p>
          </div>

          {/* Valor */}
          <div>
            <h3 className="font-semibold text-gray-900 mb-2 flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-purple-400" />
              Puntaje de Valor (0–60)
            </h3>
            <p className="text-gray-500 text-xs mb-2">
              Refleja cuánto depositó el cliente históricamente. No cambia con el tiempo.
            </p>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-gray-100 text-gray-500 uppercase">
                  <th className="px-3 py-2 text-left rounded-tl-md">Nivel</th>
                  <th className="px-3 py-2 text-left">Depósito total</th>
                  <th className="px-3 py-2 text-right rounded-tr-md">Puntos</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                <tr>
                  <td className="px-3 py-2"><span className="px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium">Super Vip</span></td>
                  <td className="px-3 py-2 text-gray-500">≥ $10.000</td>
                  <td className="px-3 py-2 text-right font-semibold text-gray-800">60</td>
                </tr>
                <tr>
                  <td className="px-3 py-2"><span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">Vip</span></td>
                  <td className="px-3 py-2 text-gray-500">≥ $3.000</td>
                  <td className="px-3 py-2 text-right font-semibold text-gray-800">45</td>
                </tr>
                <tr>
                  <td className="px-3 py-2"><span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">Medio</span></td>
                  <td className="px-3 py-2 text-gray-500">≥ $500</td>
                  <td className="px-3 py-2 text-right font-semibold text-gray-800">25</td>
                </tr>
                <tr>
                  <td className="px-3 py-2"><span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">Bajo</span></td>
                  <td className="px-3 py-2 text-gray-500">&lt; $500</td>
                  <td className="px-3 py-2 text-right font-semibold text-gray-800">10</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Urgencia */}
          <div>
            <h3 className="font-semibold text-gray-900 mb-2 flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-400" />
              Puntaje de Urgencia (0–40)
            </h3>
            <p className="text-gray-500 text-xs mb-2">
              Empieza en 40 cuando el cliente recién deja de depositar y baja gradualmente hasta 0.
              Cada nivel tiene su propia ventana de tiempo.
            </p>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-gray-100 text-gray-500 uppercase">
                  <th className="px-3 py-2 text-left rounded-tl-md">Nivel</th>
                  <th className="px-3 py-2 text-left">Ventana activa</th>
                  <th className="px-3 py-2 text-left">Urgencia al entrar</th>
                  <th className="px-3 py-2 text-right rounded-tr-md">Urgencia al salir</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                <tr>
                  <td className="px-3 py-2"><span className="px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium">Super Vip</span></td>
                  <td className="px-3 py-2 text-gray-500">7 – 180 días</td>
                  <td className="px-3 py-2 text-amber-600 font-semibold">40</td>
                  <td className="px-3 py-2 text-right text-gray-400">0</td>
                </tr>
                <tr>
                  <td className="px-3 py-2"><span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">Vip</span></td>
                  <td className="px-3 py-2 text-gray-500">7 – 150 días</td>
                  <td className="px-3 py-2 text-amber-600 font-semibold">40</td>
                  <td className="px-3 py-2 text-right text-gray-400">0</td>
                </tr>
                <tr>
                  <td className="px-3 py-2"><span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">Medio</span></td>
                  <td className="px-3 py-2 text-gray-500">14 – 60 días</td>
                  <td className="px-3 py-2 text-amber-600 font-semibold">40</td>
                  <td className="px-3 py-2 text-right text-gray-400">0</td>
                </tr>
                <tr>
                  <td className="px-3 py-2"><span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">Bajo</span></td>
                  <td className="px-3 py-2 text-gray-500">30 – 45 días</td>
                  <td className="px-3 py-2 text-amber-600 font-semibold">40</td>
                  <td className="px-3 py-2 text-right text-gray-400">0</td>
                </tr>
              </tbody>
            </table>
            <p className="text-xs text-gray-400 mt-2 italic">
              Fuera de la ventana el contacto no aparece en la lista: antes es porque todavía está activo, después porque ya está demasiado frío.
            </p>
          </div>

          {/* Segmentos */}
          <div>
            <h3 className="font-semibold text-gray-900 mb-2">Segmentos — qué mensaje enviar</h3>
            <div className="space-y-2">
              {[
                {
                  label: 'Urgente',
                  style: 'bg-red-100 text-red-700',
                  desc: 'VIP/Super Vip con 7–30 días inactivos. Memoria fresca de la marca.',
                  msg: '"Te extrañamos, volvé." — mensaje directo, sin necesidad de incentivo extra.',
                },
                {
                  label: 'Prioritaria',
                  style: 'bg-orange-100 text-orange-700',
                  desc: 'VIP/Super Vip 31–90 días · Medio 14–30 días.',
                  msg: 'Incluir incentivo: bono, free spins o cashback.',
                },
                {
                  label: 'Estándar',
                  style: 'bg-blue-100 text-blue-700',
                  desc: 'VIP/Super Vip 91–120 días · Medio 31–60 días.',
                  msg: 'Oferta especial, torneo o novedad de producto.',
                },
                {
                  label: 'Fría alto valor',
                  style: 'bg-purple-100 text-purple-700',
                  desc: 'VIP/Super Vip con 121–180 días inactivos. Alto LTV, vale la inversión.',
                  msg: 'Win-back agresivo: oferta máxima. No enviar mensaje genérico.',
                },
                {
                  label: 'Fría',
                  style: 'bg-gray-100 text-gray-600',
                  desc: 'Bajo con 30–45 días inactivos. Ventana estrecha, ROI marginal.',
                  msg: 'Mensaje de bajo costo. No invertir en incentivo grande.',
                },
              ].map(({ label, style, desc, msg }) => (
                <div key={label} className="flex gap-3 items-start">
                  <span className={`mt-0.5 shrink-0 inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${style}`}>
                    {label}
                  </span>
                  <div>
                    <p className="text-xs text-gray-500">{desc}</p>
                    <p className="text-xs text-gray-800 mt-0.5">{msg}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Ejemplo */}
          <div className="bg-green-50 border border-green-100 rounded-lg px-4 py-3">
            <p className="text-xs font-semibold text-green-800 mb-1">Ejemplo</p>
            <p className="text-xs text-green-700">
              Cliente Super Vip ($15.000 depositados) con 45 días inactivo:<br />
              <span className="font-mono">Valor = 60 · Urgencia = 31 → Score = <strong>91</strong></span><br />
              Segmento: <strong>Prioritaria</strong> — enviar con incentivo.
            </p>
          </div>

        </div>
      </DialogContent>
    </Dialog>
  )
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
  const { user } = useCurrentUser()
  const isAdmin  = user?.role === 'admin'

  const [tab, setTab]                     = useState<Tab>('pending')
  const [platform, setPlatform]           = useState<Platform>('todas')
  const [result, setResult]               = useState<PaginatedResult | null>(null)
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
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) })
      if (t === 'broadcasted') params.set('broadcasted', 'true')
      if (seg !== 'todos') params.set('reactivationSegment', seg)
      if (tr  !== 'todos') params.set('valueTier', tr)
      if (ag  !== 'todos') params.set('agent', ag)
      if (plt !== 'todas') params.set('platform', plt)
      const data = await fetchJson<PaginatedResult>(`/api/contacts/prioritized?${params}`)
      setResult(data)
    } catch {
      setResult(null)
    } finally {
      setLoading(false)
    }
  }, [page, segment, tier, agent, platform, tab])

  useEffect(() => { load() }, [load])

  const switchTab = (t: Tab) => {
    setTab(t); setPage(1)
    load(1, segment, tier, agent, platform, t)
  }

  const switchPlatform = (plt: Platform) => {
    setPlatform(plt); setPage(1)
    load(1, segment, tier, agent, plt, tab)
  }

  const handleFilter = (newSeg: string, newTier: string, newAgent: string) => {
    setPage(1); setSegment(newSeg); setTier(newTier); setAgent(newAgent)
    load(1, newSeg, newTier, newAgent, platform, tab)
  }

  const handleRecompute = async () => {
    setRecomputing(true); setRecomputeMsg(null)
    try {
      const res = await fetchJson<RecomputeResult>('/api/contacts/recompute-priorities', { method: 'POST' })
      setRecomputeMsg({
        type: 'ok',
        text: `Recompute completado: ${res.eligible} elegibles de ${res.processed} contactos (${(res.durationMs / 1000).toFixed(1)}s)`,
      })
      load(1, segment, tier, agent, platform, tab)
    } catch (err) {
      setRecomputeMsg({ type: 'error', text: err instanceof Error ? err.message : 'Error al recomputar' })
    } finally {
      setRecomputing(false)
    }
  }

  const toggleBroadcasted = async (contactId: string, markAs: boolean) => {
    setPendingAction(contactId)
    try {
      await fetchJson(`/api/contacts/prioritized/${contactId}/broadcast`, {
        method: 'PATCH',
        body: JSON.stringify({ broadcasted: markAs }),
      })
      load(1, segment, tier, agent, platform, tab)
      setPage(1)
    } catch { /* no-op */ } finally {
      setPendingAction(null)
    }
  }

  const hasFilters = segment !== 'todos' || tier !== 'todos' || agent !== 'todos'

  return (
    <div className="flex flex-col h-full bg-gray-50">

      <ScoringHelpModal open={showHelp} onClose={() => setShowHelp(false)} />

      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <TrendingUp size={20} className="text-green-600" />
            <div>
              <h1 className="text-lg font-semibold text-gray-900">Prioridades</h1>
              <p className="text-xs text-gray-500">Contactos ordenados por score de reactivación</p>
            </div>
            {result && (
              <span className="ml-2 text-sm text-gray-400 font-normal">
                {result.total.toLocaleString()} {tab === 'pending' ? 'a difundir' : 'difundidos'}
              </span>
            )}
            <button
              onClick={() => setShowHelp(true)}
              title="¿Cómo funciona el score?"
              className="p-1 rounded-full text-gray-300 hover:text-gray-500 hover:bg-gray-100 transition-colors"
            >
              <HelpCircle size={16} />
            </button>
          </div>
          {isAdmin && (
            <Button onClick={handleRecompute} disabled={recomputing} size="sm" variant="outline" className="gap-2">
              <RefreshCw size={14} className={recomputing ? 'animate-spin' : ''} />
              {recomputing ? 'Calculando…' : 'Recomputar'}
            </Button>
          )}
        </div>
        {recomputeMsg && (
          <div className={`mt-3 flex items-center gap-2 text-sm px-3 py-2 rounded-lg ${
            recomputeMsg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
          }`}>
            <AlertCircle size={14} />
            {recomputeMsg.text}
          </div>
        )}
      </div>

      {/* Tab principal: A difundir / Difundidos */}
      <div className="bg-white border-b border-gray-200 px-6 flex gap-1">
        {([
          { key: 'pending',     label: 'A difundir' },
          { key: 'broadcasted', label: 'Difundidos' },
        ] as { key: Tab; label: string }[]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => switchTab(key)}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === key
                ? 'border-green-600 text-green-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab de plataforma */}
      <div className="bg-white border-b border-gray-200 px-6 py-2 flex items-center gap-1 overflow-x-auto">
        <span className="text-xs text-gray-400 mr-1 shrink-0">Plataforma:</span>
        {PLATFORMS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => switchPlatform(key)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors shrink-0 ${
              platform === key
                ? 'bg-green-100 text-green-700'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Filtros: segmento, nivel, agente */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4 flex-wrap">
        <Filter size={14} className="text-gray-400 shrink-0" />

        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-400 shrink-0">Segmento:</span>
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
          <span className="text-xs text-gray-400 shrink-0">Nivel:</span>
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
          <span className="text-xs text-gray-400 shrink-0">Agente:</span>
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
            className="text-xs text-gray-400 hover:text-gray-600 underline"
          >
            Limpiar filtros
          </button>
        )}
      </div>

      {/* Tabla */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {loading ? (
          <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
            <RefreshCw size={16} className="animate-spin mr-2" /> Cargando…
          </div>
        ) : !result || result.data.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center gap-3">
            <TrendingUp size={32} className="text-gray-300" />
            {tab === 'pending' ? (
              <>
                <p className="text-gray-500 text-sm font-medium">No hay contactos a difundir</p>
                <p className="text-gray-400 text-xs max-w-sm">
                  {isAdmin
                    ? 'Hacé clic en "Recomputar" para calcular las prioridades.'
                    : 'Aún no hay contactos priorizados.'}
                </p>
              </>
            ) : (
              <>
                <p className="text-gray-500 text-sm font-medium">Aún no hay contactos difundidos</p>
                <p className="text-gray-400 text-xs max-w-sm">
                  Marcá contactos como difundidos desde la pestaña "A difundir".
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
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
              <tbody className="divide-y divide-gray-50">
                {result.data.map(c => (
                  <tr key={c.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 text-right">
                      <span className="font-semibold text-gray-900 tabular-nums">
                        {Math.round(c.priorityScore)}
                      </span>
                    </td>

                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{contactName(c)}</div>
                      <div className="text-xs text-gray-400">{c.phoneNumber}</div>
                    </td>

                    <td className="px-4 py-3">
                      {c.agent
                        ? <span className="text-xs font-medium text-gray-700 capitalize">{c.agent}</span>
                        : <span className="text-gray-300 text-xs">—</span>
                      }
                    </td>

                    <td className="px-4 py-3">
                      {c.reactivationSegment ? (
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${SEGMENT_STYLE[c.reactivationSegment] ?? 'bg-gray-100 text-gray-600'}`}>
                          {SEGMENT_LABEL[c.reactivationSegment] ?? c.reactivationSegment}
                        </span>
                      ) : <span className="text-gray-300">—</span>}
                    </td>

                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${TIER_STYLE[c.valueTier] ?? 'bg-gray-100 text-gray-500'}`}>
                        {TIER_LABEL[c.valueTier] ?? c.valueTier}
                      </span>
                    </td>

                    <td className="px-4 py-3 text-right">
                      {c.ltvScore != null ? (
                        <span
                          title={`LTV Tier: ${TIER_LABEL[c.ltvTier ?? ''] ?? c.ltvTier ?? '—'}`}
                          className={`inline-flex items-center justify-center w-8 h-6 rounded text-xs font-semibold tabular-nums ${TIER_STYLE[c.ltvTier ?? ''] ?? 'bg-gray-100 text-gray-500'}`}
                        >
                          {c.ltvScore}
                        </span>
                      ) : (
                        <span className="text-gray-300 text-xs">—</span>
                      )}
                    </td>

                    <td className="px-4 py-3 text-right tabular-nums text-gray-600">
                      {c.daysInactive != null ? `${c.daysInactive}d` : '—'}
                    </td>

                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {c.platforms.length > 0
                          ? c.platforms.map(p => (
                              <span key={p} className="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                                {p}
                              </span>
                            ))
                          : <span className="text-gray-300 text-xs">—</span>
                        }
                      </div>
                    </td>

                    {tab === 'broadcasted' && (
                      <td className="px-4 py-3 text-xs text-gray-500">
                        <div>{formatDate(c.broadcastedAt)}</div>
                        {c.broadcastedBy && (
                          <div className="text-gray-400">{c.broadcastedBy}</div>
                        )}
                      </td>
                    )}

                    <td className="px-4 py-3 text-right">
                      {tab === 'pending' ? (
                        <button
                          onClick={() => toggleBroadcasted(c.id, true)}
                          disabled={pendingAction === c.id}
                          title="Marcar como difundido"
                          className="p-1.5 rounded-lg text-gray-400 hover:text-green-600 hover:bg-green-50 transition-colors disabled:opacity-40"
                        >
                          {pendingAction === c.id
                            ? <RefreshCw size={14} className="animate-spin" />
                            : <CheckCircle2 size={14} />
                          }
                        </button>
                      ) : (
                        <button
                          onClick={() => toggleBroadcasted(c.id, false)}
                          disabled={pendingAction === c.id}
                          title="Volver a A difundir"
                          className="p-1.5 rounded-lg text-gray-400 hover:text-amber-600 hover:bg-amber-50 transition-colors disabled:opacity-40"
                        >
                          {pendingAction === c.id
                            ? <RefreshCw size={14} className="animate-spin" />
                            : <RotateCcw size={14} />
                          }
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
        <div className="bg-white border-t border-gray-200 px-6 py-3 flex items-center justify-between text-sm text-gray-500">
          <span>
            {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, result.total)} de {result.total.toLocaleString()}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setPage(p => p - 1); load(page - 1, segment, tier, agent, platform, tab) }}
              disabled={page <= 1}
              className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-xs">Pág. {page} de {result.totalPages}</span>
            <button
              onClick={() => { setPage(p => p + 1); load(page + 1, segment, tier, agent, platform, tab) }}
              disabled={page >= result.totalPages}
              className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
