'use client'
import { useEffect, useState, useCallback } from 'react'
import { TrendingUp, RefreshCw, ChevronLeft, ChevronRight, Filter, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
  lastDepositAt:       string | null
  totalDepositAmount:  number | null
  priorityScore:       number
  reactivationSegment: string | null
  valueTier:           string
  daysInactive:        number | null
  daysSinceLastMessage: number | null
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
  vip:   'bg-purple-100 text-purple-700',
  alto:  'bg-amber-100 text-amber-700',
  medio: 'bg-blue-100 text-blue-700',
  bajo:  'bg-gray-100 text-gray-500',
}

const TIER_LABEL: Record<string, string> = {
  vip: 'VIP', alto: 'Alto', medio: 'Medio', bajo: 'Bajo',
}

const PAGE_SIZE = 50

// ── Componente ────────────────────────────────────────────────────────────────

export default function PrioridadesPage() {
  const { user } = useCurrentUser()
  const isAdmin  = user?.role === 'admin'

  const [result, setResult]               = useState<PaginatedResult | null>(null)
  const [loading, setLoading]             = useState(false)
  const [recomputing, setRecomputing]     = useState(false)
  const [recomputeMsg, setRecomputeMsg]   = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [page, setPage]                   = useState(1)
  const [segment, setSegment]             = useState('todos')
  const [tier, setTier]                   = useState('todos')

  const load = useCallback(async (p = page, seg = segment, tr = tier) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) })
      if (seg !== 'todos') params.set('reactivationSegment', seg)
      if (tr  !== 'todos') params.set('valueTier', tr)
      const data = await fetchJson<PaginatedResult>(`/api/contacts/prioritized?${params}`)
      setResult(data)
    } catch {
      setResult(null)
    } finally {
      setLoading(false)
    }
  }, [page, segment, tier])

  useEffect(() => { load() }, [load])

  const handleFilter = (newSeg: string, newTier: string) => {
    setPage(1)
    setSegment(newSeg)
    setTier(newTier)
    load(1, newSeg, newTier)
  }

  const handleRecompute = async () => {
    setRecomputing(true)
    setRecomputeMsg(null)
    try {
      const res = await fetchJson<RecomputeResult>('/api/contacts/recompute-priorities', { method: 'POST' })
      setRecomputeMsg({ type: 'ok', text: `Recompute completado: ${res.eligible} elegibles de ${res.processed} contactos (${(res.durationMs / 1000).toFixed(1)}s)` })
      load(1, segment, tier)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al recomputar'
      setRecomputeMsg({ type: 'error', text: msg })
    } finally {
      setRecomputing(false)
    }
  }

  const name = (c: PrioritizedContact) =>
    [c.firstName, c.lastName].filter(Boolean).join(' ') || '—'

  return (
    <div className="flex flex-col h-full bg-gray-50">

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
                {result.total.toLocaleString()} elegibles
              </span>
            )}
          </div>

          {isAdmin && (
            <Button
              onClick={handleRecompute}
              disabled={recomputing}
              size="sm"
              variant="outline"
              className="gap-2"
            >
              <RefreshCw size={14} className={recomputing ? 'animate-spin' : ''} />
              {recomputing ? 'Calculando…' : 'Recomputar'}
            </Button>
          )}
        </div>

        {/* Mensaje de recompute */}
        {recomputeMsg && (
          <div className={`mt-3 flex items-center gap-2 text-sm px-3 py-2 rounded-lg ${
            recomputeMsg.type === 'ok'
              ? 'bg-green-50 text-green-700'
              : 'bg-red-50 text-red-700'
          }`}>
            <AlertCircle size={14} />
            {recomputeMsg.text}
          </div>
        )}
      </div>

      {/* Filtros */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-3">
        <Filter size={14} className="text-gray-400 shrink-0" />

        <Select value={segment} onValueChange={v => handleFilter(v ?? 'todos', tier)}>
          <SelectTrigger className="w-48 h-8 text-sm">
            <SelectValue placeholder="Segmento" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos los segmentos</SelectItem>
            <SelectItem value="REACTIVACION_URGENTE">Urgente</SelectItem>
            <SelectItem value="REACTIVACION_PRIORITARIA">Prioritaria</SelectItem>
            <SelectItem value="REACTIVACION_ESTANDAR">Estándar</SelectItem>
            <SelectItem value="REACTIVACION_FRIA_ALTO_VALOR">Fría alto valor</SelectItem>
            <SelectItem value="REACTIVACION_FRIA">Fría</SelectItem>
          </SelectContent>
        </Select>

        <Select value={tier} onValueChange={v => handleFilter(segment, v ?? 'todos')}>
          <SelectTrigger className="w-36 h-8 text-sm">
            <SelectValue placeholder="Tier" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos los tiers</SelectItem>
            <SelectItem value="vip">VIP</SelectItem>
            <SelectItem value="alto">Alto</SelectItem>
            <SelectItem value="medio">Medio</SelectItem>
            <SelectItem value="bajo">Bajo</SelectItem>
          </SelectContent>
        </Select>

        {(segment !== 'todos' || tier !== 'todos') && (
          <button
            onClick={() => handleFilter('todos', 'todos')}
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
            <p className="text-gray-500 text-sm font-medium">No hay contactos elegibles</p>
            <p className="text-gray-400 text-xs max-w-sm">
              {isAdmin
                ? 'Hacé clic en "Recomputar" para calcular las prioridades de reactivación.'
                : 'Aún no hay contactos priorizados. Pedile a un administrador que ejecute el recompute.'}
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-3 text-right w-16">Score</th>
                  <th className="px-4 py-3 text-left">Contacto</th>
                  <th className="px-4 py-3 text-left">Segmento</th>
                  <th className="px-4 py-3 text-left w-20">Tier</th>
                  <th className="px-4 py-3 text-right w-28">Días inactivo</th>
                  <th className="px-4 py-3 text-right w-28">Último msg</th>
                  <th className="px-4 py-3 text-left">Plataformas</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {result.data.map(c => (
                  <tr key={c.id} className="hover:bg-gray-50 transition-colors">
                    {/* Score */}
                    <td className="px-4 py-3 text-right">
                      <span className="font-semibold text-gray-900 tabular-nums">
                        {Math.round(c.priorityScore)}
                      </span>
                    </td>

                    {/* Contacto */}
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{name(c)}</div>
                      <div className="text-xs text-gray-400">{c.phoneNumber}</div>
                    </td>

                    {/* Segmento */}
                    <td className="px-4 py-3">
                      {c.reactivationSegment ? (
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${SEGMENT_STYLE[c.reactivationSegment] ?? 'bg-gray-100 text-gray-600'}`}>
                          {SEGMENT_LABEL[c.reactivationSegment] ?? c.reactivationSegment}
                        </span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>

                    {/* Tier */}
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${TIER_STYLE[c.valueTier] ?? 'bg-gray-100 text-gray-500'}`}>
                        {TIER_LABEL[c.valueTier] ?? c.valueTier}
                      </span>
                    </td>

                    {/* Días inactivo */}
                    <td className="px-4 py-3 text-right tabular-nums text-gray-600">
                      {c.daysInactive != null ? `${c.daysInactive}d` : '—'}
                    </td>

                    {/* Último mensaje */}
                    <td className="px-4 py-3 text-right tabular-nums text-gray-400 text-xs">
                      {c.daysSinceLastMessage != null ? `hace ${c.daysSinceLastMessage}d` : 'nunca'}
                    </td>

                    {/* Plataformas */}
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
              onClick={() => { setPage(p => p - 1); load(page - 1, segment, tier) }}
              disabled={page <= 1}
              className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-xs">Pág. {page} de {result.totalPages}</span>
            <button
              onClick={() => { setPage(p => p + 1); load(page + 1, segment, tier) }}
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
