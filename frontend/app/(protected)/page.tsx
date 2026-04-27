'use client'
import { useEffect, useState } from 'react'
import * as XLSX from 'xlsx'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  MessageSquare, Send, AlertCircle, Eye, Wifi, Clock,
  BarChart2, Shield, TrendingUp, TrendingDown, Users, Star, Download, Search,
  TriangleAlert, Flame, BadgeDollarSign, HeartPulse,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { fetchJson } from '@/lib/fetchJson'
import type { CasinoSummary, CasinoAgente, CasinoVip } from '@/app/api/dashboard/casino/route'
import type { CasinoJugador } from '@/app/api/dashboard/casino/players/route'
import type { RiskSummary, NuevoExtractor, DeficitJugador, VipRecuperable } from '@/app/api/dashboard/casino/risk/route'

// ── Tipos dashboard de difusión ───────────────────────────────────────────────
interface Stats {
  total: string; sent: string; failed: string; delivered: string
  read: string; inbound: string; last_24h: string; read_rate: string
}
interface CampaignStats { total: number; sent: number; sending: number; scheduled: number }
interface Line {
  line_key: string; display_name: string; status: string
  is_connected: boolean; msgs_sent_today: number; msg_per_day: number
  evolution_instance: string
}
interface Message {
  phone_number: string; message_body: string
  direction: string; status: string; created_at: string
}
interface CasinoData {
  summary: CasinoSummary | null
  agentes: CasinoAgente[]
  vips:    CasinoVip[]
}

interface RiskData {
  summary:      RiskSummary | null
  extractores:  NuevoExtractor[]
  deficit:      DeficitJugador[]
  recuperables: VipRecuperable[]
}

// ── Constantes de display ─────────────────────────────────────────────────────
const NIVEL_LABEL: Record<string, string> = {
  bajo:  'Bronce',
  medio: 'Plata',
  alto:  'Oro',
  vip:   'Platino',
}

const NIVEL_STYLE: Record<string, string> = {
  bajo:  'bg-orange-50 text-orange-700',
  medio: 'bg-slate-100 text-slate-600',
  alto:  'bg-yellow-100 text-yellow-700',
  vip:   'bg-purple-100 text-purple-700',
}

const ACTIVIDAD_STYLE: Record<string, string> = {
  frecuente:  'bg-green-100 text-green-700',
  regular:    'bg-blue-100 text-blue-700',
  nuevo:      'bg-cyan-100 text-cyan-700',
  ocasional:  'bg-gray-100 text-gray-600',
  en_riesgo:  'bg-orange-100 text-orange-700',
  inactivo:   'bg-red-100 text-red-600',
  perdido:    'bg-zinc-800 text-white',
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function delta(current: number, prev: number) {
  const d = current - prev
  const pct = prev > 0 ? Math.round((d / prev) * 100) : null
  return { d, pct }
}

function fmtMoney(n: number) {
  return '$' + n.toLocaleString('es-AR')
}

// ── Componente principal ──────────────────────────────────────────────────────
export default function Dashboard() {
  const [stats,  setStats]  = useState<Stats | null>(null)
  const [lines,  setLines]  = useState<Line[]>([])
  const [recent, setRecent] = useState<Message[]>([])
  const [cs,     setCs]     = useState<CampaignStats | null>(null)
  const [tab,            setTab]            = useState<'difusion' | 'casino'>('difusion')
  const [casino,         setCasino]         = useState<CasinoData | null>(null)
  const [casinoError,    setCasinoError]    = useState<string | null>(null)
  const [risk,           setRisk]           = useState<RiskData | null>(null)
  const [riskTab,        setRiskTab]        = useState<'extractores' | 'deficit' | 'recuperables'>('extractores')
  const [filterAgente,   setFilterAgente]   = useState<string>('__all__')
  const [jugadores,      setJugadores]      = useState<CasinoJugador[]>([])
  const [loadingJug,     setLoadingJug]     = useState(false)

  // ── Filtros del panel de búsqueda (inputs sin aplicar) ─────────────────────
  const [inputUsername,   setInputUsername]   = useState('')
  const [inputNivel,      setInputNivel]      = useState('__all__')
  const [inputFechaDesde, setInputFechaDesde] = useState('')
  const [inputFechaHasta, setInputFechaHasta] = useState('')

  // ── Filtros aplicados (disparan el fetch) ──────────────────────────────────
  const [appliedFilters, setAppliedFilters] = useState({
    username: '', nivel: '__all__', fechaDesde: '', fechaHasta: '',
  })

  useEffect(() => {
    fetchJson<{ stats: Stats; lines: Line[]; recent: Message[]; campaignStats: CampaignStats }>('/api/dashboard')
      .then(d => { setStats(d.stats); setLines(d.lines || []); setRecent(d.recent || []); setCs(d.campaignStats) })
      .catch(() => {})

    fetchJson<CasinoData>('/api/dashboard/casino')
      .then(d => { setCasino(d); setCasinoError(null) })
      .catch((e: unknown) => setCasinoError(e instanceof Error ? e.message : 'Error al cargar datos de casino'))

    fetchJson<RiskData>('/api/dashboard/casino/risk')
      .then(d => setRisk(d))
      .catch(() => {})
  }, [])

  // Re-fetch riesgo cuando cambia el agente
  useEffect(() => {
    const params = new URLSearchParams()
    if (filterAgente !== '__all__') params.set('agente', filterAgente)
    const qs = params.toString()
    fetchJson<RiskData>(`/api/dashboard/casino/risk${qs ? '?' + qs : ''}`)
      .then(d => setRisk(d))
      .catch(() => {})
  }, [filterAgente])

  // Re-fetch jugadores cuando cambia agente o filtros aplicados
  useEffect(() => {
    setLoadingJug(true)
    const params = new URLSearchParams()
    if (filterAgente !== '__all__')             params.set('agente',      filterAgente)
    if (appliedFilters.username)                params.set('username',    appliedFilters.username)
    if (appliedFilters.nivel !== '__all__')      params.set('seg_monto',   appliedFilters.nivel)
    if (appliedFilters.fechaDesde)              params.set('fecha_desde', appliedFilters.fechaDesde)
    if (appliedFilters.fechaHasta)              params.set('fecha_hasta', appliedFilters.fechaHasta)
    const qs = params.toString()
    fetchJson<{ jugadores: CasinoJugador[] }>(`/api/dashboard/casino/players${qs ? '?' + qs : ''}`)
      .then(d => setJugadores(d.jugadores ?? []))
      .catch(() => setJugadores([]))
      .finally(() => setLoadingJug(false))
  }, [filterAgente, appliedFilters])

  const s    = stats
  const sum  = casino?.summary ?? null
  const agts = casino?.agentes ?? []
  const vips = casino?.vips    ?? []

  // Agentes únicos para el filtro
  const agentesDisponibles = agts.map(a => a.agente)

  // Filtro de agentes para la tabla por agente
  const agtesFiltrados = filterAgente === '__all__'
    ? agts
    : agts.filter(a => a.agente === filterAgente)

  // Filtro de VIPs por agente
  const vipsFiltrados = filterAgente === '__all__'
    ? vips
    : vips.filter(v => v.agente === filterAgente)

  // Totales financieros del conjunto de jugadores cargado
  const finCargas  = jugadores.reduce((s, j) => s + Number(j.total_cargas),  0)
  const finRetiros = jugadores.reduce((s, j) => s + Number(j.total_retiros), 0)
  const finNeto    = finCargas - finRetiros

  // ── Helpers de fecha rápida ────────────────────────────────────────────────
  function toISODate(d: Date) {
    return d.toISOString().split('T')[0]
  }

  function aplicarRapido(tipo: 'hoy' | 'ayer' | 'semana' | 'mes_anterior' | 'mes_actual') {
    const hoy  = new Date()
    let desde  = ''
    let hasta  = ''

    if (tipo === 'hoy') {
      desde = hasta = toISODate(hoy)
    } else if (tipo === 'ayer') {
      const ayer = new Date(hoy); ayer.setDate(hoy.getDate() - 1)
      desde = hasta = toISODate(ayer)
    } else if (tipo === 'semana') {
      const ini = new Date(hoy); ini.setDate(hoy.getDate() - 6)
      desde = toISODate(ini); hasta = toISODate(hoy)
    } else if (tipo === 'mes_anterior') {
      const primero = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1)
      const ultimo  = new Date(hoy.getFullYear(), hoy.getMonth(), 0)
      desde = toISODate(primero); hasta = toISODate(ultimo)
    } else if (tipo === 'mes_actual') {
      const primero = new Date(hoy.getFullYear(), hoy.getMonth(), 1)
      desde = toISODate(primero); hasta = toISODate(hoy)
    }

    setInputFechaDesde(desde)
    setInputFechaHasta(hasta)
    setAppliedFilters(prev => ({ ...prev, fechaDesde: desde, fechaHasta: hasta }))
  }

  function handleBuscar() {
    setAppliedFilters({
      username:   inputUsername.trim(),
      nivel:      inputNivel,
      fechaDesde: inputFechaDesde,
      fechaHasta: inputFechaHasta,
    })
  }

  function handleLimpiar() {
    setInputUsername(''); setInputNivel('__all__')
    setInputFechaDesde(''); setInputFechaHasta('')
    setAppliedFilters({ username: '', nivel: '__all__', fechaDesde: '', fechaHasta: '' })
  }

  const filtrosActivos = appliedFilters.username || appliedFilters.nivel !== '__all__'
    || appliedFilters.fechaDesde || appliedFilters.fechaHasta

  // Variaciones periodo anterior
  const varNuevos  = sum ? delta(sum.nuevos_mes,  sum.nuevos_anterior)  : null
  const varActivos = sum ? delta(sum.activos_mes, sum.activos_anterior) : null

  // XLSX export tabla financiera
  const exportarJugadores = () => {
    const rows = jugadores.map(j => ({
      'Usuario':        j.username,
      'Agente':         j.agente,
      'Cargas ($)':     j.total_cargas,
      '# Cargas':       j.cant_cargas,
      'Retiros ($)':   -j.total_retiros,
      '# Retiros':      j.cant_retiros,
      'Neto ($)':       j.neto,
      'Nivel':          NIVEL_LABEL[j.seg_monto] ?? j.seg_monto,
      'Estado':         j.seg_actividad,
      'Días sin mov.':  j.dias_ultimo ?? '',
      'Últ. actividad': j.fecha_ultima ?? '',
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Reporte')
    ws['!cols'] = [20,12,14,10,14,10,14,10,12,14,14].map(w => ({ wch: w }))
    const ag    = filterAgente === '__all__' ? 'todos' : filterAgente
    const rango = appliedFilters.fechaDesde && appliedFilters.fechaHasta
      ? `${appliedFilters.fechaDesde}_${appliedFilters.fechaHasta}`
      : 'historico'
    XLSX.writeFile(wb, `casino_jugadores_${ag}_${rango}_${new Date().toISOString().slice(0,10)}.xlsx`)
  }

  // CSV export para tabla VIP
  const exportarVips = () => {
    const rows = vipsFiltrados.map(v => ({
      'Usuario':                    v.username,
      'Agente':                     v.agente,
      'Nivel':                      NIVEL_LABEL[v.seg_monto] ?? v.seg_monto,
      'Estado':                     v.seg_actividad,
      'Días sin movimiento':        v.dias_ultimo,
      'Cargas totales ($)':         v.total_cargas,
      '# Cargas':                   v.cant_cargas,
      'Retiros totales ($)':        v.total_retiros,
      '# Retiros':                  v.cant_retiros,
      'Neto ($)':                   v.total_cargas - v.total_retiros,
      'Último movimiento':          v.fecha_ultima,
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'VIP_Alto')
    ws['!cols'] = [18, 12, 10, 12, 20, 18, 10, 12, 16].map(w => ({ wch: w }))
    const filtro   = filterAgente === '__all__' ? 'todos' : filterAgente
    const filename = `casino_vip_${filtro}_${new Date().toISOString().slice(0, 10)}.xlsx`
    XLSX.writeFile(wb, filename)
  }

  return (
    <div className="space-y-6">
      {/* ── Encabezado ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="text-sm text-gray-500">Resumen en tiempo real</p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-green-600 bg-green-50 px-2 py-1 rounded-full">
          <Shield size={12}/> Antibloqueo activo
        </div>
      </div>

      {/* ── Tabs de sección ──────────────────────────────────────────────── */}
      <div className="flex gap-1 border-b border-gray-200">
        {([
          { key: 'difusion', label: 'Difusión' },
          { key: 'casino',   label: 'Casino / Agentes' },
        ] as const).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-5 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === key
                ? 'border-gray-900 text-gray-900'
                : 'border-transparent text-gray-400 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          SECCIÓN: Difusión / Broadcast
          ══════════════════════════════════════════════════════════════════ */}
      <div className={tab === 'difusion' ? 'space-y-6' : 'hidden'}>
        {/* Métricas principales de mensajes */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard icon={<Send size={18} className="text-blue-500"/>}
            label="Enviados (total)" value={s?.sent ?? '—'} />
          <MetricCard icon={<Eye size={18} className="text-purple-500"/>}
            label="Leídos" value={s?.read ?? '—'}
            sub={s?.read_rate ? `${s.read_rate}% tasa de lectura` : undefined} />
          <MetricCard icon={<MessageSquare size={18} className="text-green-500"/>}
            label="Entrantes" value={s?.inbound ?? '—'} />
          <MetricCard icon={<AlertCircle size={18} className="text-red-500"/>}
            label="Fallidos" value={s?.failed ?? '—'} bad={Number(s?.failed) > 0} />
        </div>

        {/* Campañas */}
        {cs && (
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: 'Campañas totales',    value: cs.total,     color: 'gray'   },
            { label: 'Enviadas',            value: cs.sent,      color: 'green'  },
            { label: 'Enviando ahora',      value: cs.sending,   color: 'yellow' },
            { label: 'Programadas',         value: cs.scheduled, color: 'blue'   },
          ].map(({ label, value, color }) => (
            <Card key={label}>
              <CardContent className="pt-4 pb-3">
                <p className={`text-xl font-bold ${
                  color==='green'?'text-green-600':color==='yellow'?'text-yellow-600':color==='blue'?'text-blue-600':''
                }`}>{value}</p>
                <p className="text-xs text-gray-500 mt-0.5">{label}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Líneas */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Wifi size={15}/> Líneas activas
            </CardTitle>
          </CardHeader>
          <CardContent>
            {lines.length === 0
              ? <p className="text-sm text-gray-400">Sin líneas activas</p>
              : <div className="space-y-2">
                  {lines.map(l => {
                    const pct = l.msg_per_day ? (l.msgs_sent_today / l.msg_per_day) * 100 : 0
                    return (
                      <div key={l.line_key} className="py-1.5 border-b border-gray-100 last:border-0">
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${l.is_connected ? 'bg-green-500' : 'bg-gray-300'}`}/>
                            <span className="text-sm">{l.display_name || l.evolution_instance}</span>
                          </div>
                          <span className="text-xs text-gray-500">{l.msgs_sent_today}/{l.msg_per_day}</span>
                        </div>
                        <div className="w-full bg-gray-100 rounded-full h-1">
                          <div className="bg-green-400 h-1 rounded-full" style={{width:`${Math.min(pct,100)}%`}}/>
                        </div>
                      </div>
                    )
                  })}
                </div>
            }
          </CardContent>
        </Card>

        {/* Actividad reciente */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Clock size={15}/> Actividad reciente
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recent.length === 0
              ? <p className="text-sm text-gray-400">Sin mensajes aún</p>
              : <div className="space-y-1">
                  {recent.map((m, i) => (
                    <div key={i} className="flex items-start gap-2 py-1.5 border-b border-gray-100 last:border-0">
                      <Badge variant={m.direction === 'inbound' ? 'secondary' : 'outline'} className="text-xs shrink-0 mt-0.5">
                        {m.direction === 'inbound' ? '↓' : '↑'}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-gray-500">{m.phone_number}</p>
                        <p className="text-sm truncate">{m.message_body}</p>
                      </div>
                      <span className={`text-xs shrink-0 ${
                        m.status==='read'       ? 'text-purple-500'
                        : m.status==='delivered'? 'text-green-500'
                        : m.status==='failed'   ? 'text-red-400'
                        :                         'text-gray-400'
                      }`}>
                        {m.status==='read'?'leído':m.status==='delivered'?'entregado':m.status==='failed'?'fallido':m.status}
                      </span>
                    </div>
                  ))}
                </div>
            }
          </CardContent>
        </Card>
      </div>

      {/* Tasa de lectura */}
      {s && Number(s.read_rate) > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <BarChart2 size={15}/> Tasa de lectura global
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                  <span>Leídos vs Enviados</span><span>{s.read_rate}%</span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-3">
                  <div className="bg-purple-500 h-3 rounded-full" style={{width:`${Math.min(Number(s.read_rate),100)}%`}}/>
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="text-2xl font-bold text-purple-600">{s.read_rate}%</p>
                <p className="text-xs text-gray-400">{s.read} de {s.sent}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      </div>{/* ── fin tab Difusión ── */}

      {/* ══════════════════════════════════════════════════════════════════════
          SECCIÓN: Casino / Agentes
          ══════════════════════════════════════════════════════════════════ */}
      <div className={tab === 'casino' ? 'space-y-4' : 'hidden'}>

        {/* Error explícito — reemplaza el silencio actual */}
        {casinoError && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertCircle size={16} className="mt-0.5 shrink-0"/>
            <div>
              <p className="font-medium">Error al cargar métricas de casino</p>
              <p className="text-xs text-red-500 mt-0.5 font-mono">{casinoError}</p>
            </div>
          </div>
        )}

        {/* Filtro global de agente — aplica a tabla de agentes Y tabla VIP */}
        <div className="flex items-center gap-3 mb-4">
          <Select value={filterAgente} onValueChange={(v) => setFilterAgente(v ?? '__all__')}>
            <SelectTrigger className="w-48 h-8 text-sm">
              <SelectValue placeholder="Todos los agentes"/>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Todos los agentes</SelectItem>
              {agentesDisponibles.map(a => (
                <SelectItem key={a} value={a}>{a}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {sum && (
            <span className="text-xs text-gray-400">
              {sum.total_jugadores.toLocaleString('es-AR')} jugadores totales
            </span>
          )}
        </div>

        {/* ── Tarjetas resumen ──────────────────────────────────────────── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          {/* Nuevos último mes */}
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-center gap-2 mb-1">
                <Users size={16} className="text-cyan-500"/>
                <span className="text-xs text-gray-500">Nuevos último mes</span>
              </div>
              <p className="text-2xl font-bold">{sum?.nuevos_mes ?? '—'}</p>
              {varNuevos && (
                <DeltaBadge d={varNuevos.d} pct={varNuevos.pct}/>
              )}
              <p className="text-xs text-gray-400 mt-0.5">por fecha de primer movimiento</p>
            </CardContent>
          </Card>

          {/* Activos último mes */}
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-center gap-2 mb-1">
                <TrendingUp size={16} className="text-green-500"/>
                <span className="text-xs text-gray-500">Activos último mes</span>
              </div>
              <p className="text-2xl font-bold">{sum?.activos_mes ?? '—'}</p>
              {varActivos && (
                <DeltaBadge d={varActivos.d} pct={varActivos.pct}/>
              )}
              <p className="text-xs text-gray-400 mt-0.5">con movimiento en los últimos 30 días</p>
            </CardContent>
          </Card>

          {/* VIP Platino total */}
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-center gap-2 mb-1">
                <Star size={16} className="text-purple-500"/>
                <span className="text-xs text-gray-500">VIP Platino</span>
              </div>
              <p className="text-2xl font-bold text-purple-600">{sum?.total_vip ?? '—'}</p>
              <p className="text-xs text-gray-400 mt-0.5">jugadores de mayor volumen</p>
            </CardContent>
          </Card>

          {/* Prioridad reactivación */}
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle size={16} className="text-orange-500"/>
                <span className="text-xs text-gray-500">Prioridad reactivación</span>
              </div>
              <p className="text-2xl font-bold text-orange-600">{sum?.prioridad_reactivacion ?? '—'}</p>
              <p className="text-xs text-gray-400 mt-0.5">VIP/Oro inactivos o en riesgo</p>
            </CardContent>
          </Card>
        </div>

        {/* ── Sector de Riesgo ─────────────────────────────────────────── */}
        {risk && (
          <Card className="mb-4 border-orange-200">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <TriangleAlert size={16} className="text-orange-500"/>
                <CardTitle className="text-sm font-medium text-orange-700">Sector de Riesgo</CardTitle>
              </div>

              {/* Métricas de riesgo */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
                <button
                  onClick={() => setRiskTab('extractores')}
                  className={`rounded-lg border p-3 text-left transition-colors ${riskTab === 'extractores' ? 'bg-red-50 border-red-300' : 'bg-white border-gray-200 hover:border-orange-200'}`}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <Flame size={13} className="text-red-500"/>
                    <p className="text-xs text-gray-500">Nuevos extractores</p>
                  </div>
                  <p className="text-2xl font-bold text-red-600">{risk.summary?.nuevos_extractores ?? '—'}</p>
                  <p className="text-xs text-gray-400 mt-0.5">ingresos {'<'} 90d, retiro {'>'} 60%</p>
                </button>

                <button
                  onClick={() => setRiskTab('deficit')}
                  className={`rounded-lg border p-3 text-left transition-colors ${riskTab === 'deficit' ? 'bg-orange-50 border-orange-300' : 'bg-white border-gray-200 hover:border-orange-200'}`}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <BadgeDollarSign size={13} className="text-orange-500"/>
                    <p className="text-xs text-gray-500">En déficit</p>
                  </div>
                  <p className="text-2xl font-bold text-orange-600">{risk.summary?.jugadores_deficit ?? '—'}</p>
                  <p className="text-xs text-gray-400 mt-0.5">retiraron más de lo que cargaron</p>
                </button>

                <div className="rounded-lg border border-gray-200 bg-white p-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <TrendingDown size={13} className="text-red-400"/>
                    <p className="text-xs text-gray-500">Pérdida bruta casino</p>
                  </div>
                  <p className="text-xl font-bold text-red-600">
                    {risk.summary ? fmtMoney(Number(risk.summary.perdida_bruta)) : '—'}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">suma neta en jugadores déficit</p>
                </div>

                <button
                  onClick={() => setRiskTab('recuperables')}
                  className={`rounded-lg border p-3 text-left transition-colors ${riskTab === 'recuperables' ? 'bg-yellow-50 border-yellow-300' : 'bg-white border-gray-200 hover:border-orange-200'}`}
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <HeartPulse size={13} className="text-yellow-600"/>
                    <p className="text-xs text-gray-500">VIP recuperables</p>
                  </div>
                  <p className="text-2xl font-bold text-yellow-600">{risk.summary?.vip_recuperables ?? '—'}</p>
                  <p className="text-xs text-gray-400 mt-0.5">VIP/Oro aún en riesgo, no perdidos</p>
                </button>
              </div>
            </CardHeader>

            <CardContent className="p-0">
              {/* Tab: Nuevos extractores */}
              {riskTab === 'extractores' && (
                <div className="overflow-x-auto">
                  {risk.extractores.length === 0
                    ? <p className="text-sm text-gray-400 px-4 py-4">Sin nuevos extractores detectados.</p>
                    : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-gray-100 bg-red-50">
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Usuario</th>
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Agente</th>
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Nivel</th>
                            <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Días desde ingreso</th>
                            <th className="text-right px-4 py-2 text-xs font-medium text-green-600">Cargas</th>
                            <th className="text-right px-4 py-2 text-xs font-medium text-gray-400">#</th>
                            <th className="text-right px-4 py-2 text-xs font-medium text-red-500">Retiros</th>
                            <th className="text-right px-4 py-2 text-xs font-medium text-gray-400">#</th>
                            <th className="text-right px-4 py-2 text-xs font-medium text-orange-600">% Extracción</th>
                          </tr>
                        </thead>
                        <tbody>
                          {risk.extractores.map((e, i) => (
                            <tr key={i} className="border-b border-gray-50 last:border-0 hover:bg-red-50/40">
                              <td className="px-4 py-2.5 font-mono text-xs">{e.username}</td>
                              <td className="px-4 py-2.5 text-gray-500 text-xs">{e.agente}</td>
                              <td className="px-4 py-2.5">
                                <Badge className={`text-xs ${NIVEL_STYLE[e.seg_monto] ?? 'bg-gray-100 text-gray-600'}`}>
                                  {NIVEL_LABEL[e.seg_monto] ?? e.seg_monto}
                                </Badge>
                              </td>
                              <td className="px-4 py-2.5 text-right text-gray-600">{e.dias_desde_ingreso}d</td>
                              <td className="px-4 py-2.5 text-right text-green-700 font-medium">{fmtMoney(Number(e.total_cargas))}</td>
                              <td className="px-4 py-2.5 text-right text-gray-400 text-xs">{e.cant_cargas}</td>
                              <td className="px-4 py-2.5 text-right text-red-600 font-medium">−{fmtMoney(Number(e.total_retiros))}</td>
                              <td className="px-4 py-2.5 text-right text-gray-400 text-xs">{e.cant_retiros}</td>
                              <td className="px-4 py-2.5 text-right">
                                <span className={`font-bold ${Number(e.ratio_retiro_pct) >= 90 ? 'text-red-600' : 'text-orange-500'}`}>
                                  {e.ratio_retiro_pct}%
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}

              {/* Tab: Déficit del casino */}
              {riskTab === 'deficit' && (
                <div className="overflow-x-auto">
                  {risk.deficit.length === 0
                    ? <p className="text-sm text-gray-400 px-4 py-4">Sin jugadores en déficit.</p>
                    : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-gray-100 bg-orange-50">
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Usuario</th>
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Agente</th>
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Nivel</th>
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Estado</th>
                            <th className="text-right px-4 py-2 text-xs font-medium text-green-600">Cargas</th>
                            <th className="text-right px-4 py-2 text-xs font-medium text-red-500">Retiros</th>
                            <th className="text-right px-4 py-2 text-xs font-medium text-orange-600">Déficit casino</th>
                            <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Últ. actividad</th>
                          </tr>
                        </thead>
                        <tbody>
                          {risk.deficit.map((d, i) => (
                            <tr key={i} className="border-b border-gray-50 last:border-0 hover:bg-orange-50/40">
                              <td className="px-4 py-2.5 font-mono text-xs">{d.username}</td>
                              <td className="px-4 py-2.5 text-gray-500 text-xs">{d.agente}</td>
                              <td className="px-4 py-2.5">
                                <Badge className={`text-xs ${NIVEL_STYLE[d.seg_monto] ?? 'bg-gray-100 text-gray-600'}`}>
                                  {NIVEL_LABEL[d.seg_monto] ?? d.seg_monto}
                                </Badge>
                              </td>
                              <td className="px-4 py-2.5">
                                <Badge className={`text-xs ${ACTIVIDAD_STYLE[d.seg_actividad] ?? 'bg-gray-100 text-gray-600'}`}>
                                  {d.seg_actividad}
                                </Badge>
                              </td>
                              <td className="px-4 py-2.5 text-right text-green-700 font-medium">{fmtMoney(Number(d.total_cargas))}</td>
                              <td className="px-4 py-2.5 text-right text-red-600 font-medium">−{fmtMoney(Number(d.total_retiros))}</td>
                              <td className="px-4 py-2.5 text-right font-bold text-orange-600">
                                −{fmtMoney(Number(d.deficit))}
                              </td>
                              <td className="px-4 py-2.5 text-right text-gray-400 text-xs">{d.fecha_ultima ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}

              {/* Tab: VIP recuperables */}
              {riskTab === 'recuperables' && (
                <div className="overflow-x-auto">
                  {risk.recuperables.length === 0
                    ? <p className="text-sm text-gray-400 px-4 py-4">Sin VIP/Oro en riesgo recuperable.</p>
                    : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-gray-100 bg-yellow-50">
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Usuario</th>
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Agente</th>
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Nivel</th>
                            <th className="text-right px-4 py-2 text-xs font-medium text-green-600">Cargas hist.</th>
                            <th className="text-right px-4 py-2 text-xs font-medium text-red-500">Retiros hist.</th>
                            <th className="text-right px-4 py-2 text-xs font-medium text-blue-600">Neto</th>
                            <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Días inactivo</th>
                            <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Últ. actividad</th>
                          </tr>
                        </thead>
                        <tbody>
                          {risk.recuperables.map((r, i) => {
                            const neto = Number(r.total_cargas) - Number(r.total_retiros)
                            return (
                              <tr key={i} className="border-b border-gray-50 last:border-0 hover:bg-yellow-50/40">
                                <td className="px-4 py-2.5 font-mono text-xs">{r.username}</td>
                                <td className="px-4 py-2.5 text-gray-500 text-xs">{r.agente}</td>
                                <td className="px-4 py-2.5">
                                  <Badge className={`text-xs ${NIVEL_STYLE[r.seg_monto] ?? 'bg-gray-100 text-gray-600'}`}>
                                    {NIVEL_LABEL[r.seg_monto] ?? r.seg_monto}
                                  </Badge>
                                </td>
                                <td className="px-4 py-2.5 text-right text-green-700 font-medium">{fmtMoney(Number(r.total_cargas))}</td>
                                <td className="px-4 py-2.5 text-right text-red-600">−{fmtMoney(Number(r.total_retiros))}</td>
                                <td className={`px-4 py-2.5 text-right font-semibold ${neto >= 0 ? 'text-blue-700' : 'text-orange-600'}`}>
                                  {neto >= 0 ? '' : '−'}{fmtMoney(Math.abs(neto))}
                                </td>
                                <td className="px-4 py-2.5 text-right">
                                  <span className={r.dias_ultimo > 14 ? 'text-orange-600 font-medium' : 'text-gray-600'}>
                                    {r.dias_ultimo}d
                                  </span>
                                </td>
                                <td className="px-4 py-2.5 text-right text-gray-400 text-xs">{r.fecha_ultima ?? '—'}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    )
                  }
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── Chart: distribución financiera por agente (CSS bars) ─────── */}
        {agts.length > 0 && (
          <Card className="mb-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Distribución por agente</CardTitle>
            </CardHeader>
            <CardContent>
              {(() => {
                const totalCargas  = agts.reduce((s, a) => s + Number(a.sum_cargas),  0)
                const totalJugadores = agts.reduce((s, a) => s + a.total, 0)
                const COLORS = ['bg-blue-500','bg-green-500','bg-purple-500','bg-orange-400','bg-cyan-500']
                return (
                  <div className="space-y-3">
                    {/* Barra apilada de jugadores */}
                    <div>
                      <p className="text-xs text-gray-400 mb-1">Jugadores por agente</p>
                      <div className="flex h-5 rounded overflow-hidden w-full">
                        {agts.map((a, i) => {
                          const pct = totalJugadores > 0 ? (a.total / totalJugadores) * 100 : 0
                          return (
                            <div key={a.agente}
                              className={`${COLORS[i % COLORS.length]} flex items-center justify-center`}
                              style={{ width: `${pct}%` }}
                              title={`${a.agente}: ${a.total.toLocaleString('es-AR')} jugadores (${Math.round(pct)}%)`}
                            >
                              {pct > 8 && <span className="text-white text-xs font-medium truncate px-1">{a.agente}</span>}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                    {/* Barra apilada de cargas */}
                    <div>
                      <p className="text-xs text-gray-400 mb-1">Cargas acumuladas por agente</p>
                      <div className="flex h-5 rounded overflow-hidden w-full">
                        {agts.map((a, i) => {
                          const pct = totalCargas > 0 ? (Number(a.sum_cargas) / totalCargas) * 100 : 0
                          return (
                            <div key={a.agente}
                              className={`${COLORS[i % COLORS.length]} opacity-80 flex items-center justify-center`}
                              style={{ width: `${pct}%` }}
                              title={`${a.agente}: ${fmtMoney(Number(a.sum_cargas))} (${Math.round(pct)}%)`}
                            >
                              {pct > 8 && <span className="text-white text-xs font-medium truncate px-1">{Math.round(pct)}%</span>}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                    {/* Leyenda */}
                    <div className="flex flex-wrap gap-3 pt-1">
                      {agts.map((a, i) => (
                        <div key={a.agente} className="flex items-center gap-1.5">
                          <span className={`w-2.5 h-2.5 rounded-full ${COLORS[i % COLORS.length]}`}/>
                          <span className="text-xs text-gray-600">{a.agente}</span>
                          <span className="text-xs text-gray-400">({a.total.toLocaleString('es-AR')})</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}
            </CardContent>
          </Card>
        )}

        {/* ── Tabla por agente ──────────────────────────────────────────── */}
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Por agente</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {agtesFiltrados.length === 0
              ? <p className="text-sm text-gray-400 px-4 pb-4">Sin datos de agentes aún.</p>
              : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Agente</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Total</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Nuevos 30d</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Activos 30d</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Platino</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Inact./Riesgo</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-green-600">Σ Cargas</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-red-500">Σ Retiros</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Prom./jugador</th>
                        <th className="px-4 py-2 w-28 text-xs font-medium text-gray-500">% Activos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agtesFiltrados.map(a => {
                        const pct = a.total > 0 ? Math.round((a.activos_mes / a.total) * 100) : 0
                        return (
                          <tr key={a.agente} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                            <td className="px-4 py-2.5 font-medium">{a.agente}</td>
                            <td className="px-4 py-2.5 text-right text-gray-700">{a.total.toLocaleString('es-AR')}</td>
                            <td className="px-4 py-2.5 text-right text-cyan-700">{a.nuevos_mes}</td>
                            <td className="px-4 py-2.5 text-right text-green-700">{a.activos_mes}</td>
                            <td className="px-4 py-2.5 text-right text-purple-700">{a.vip}</td>
                            <td className="px-4 py-2.5 text-right">
                              {a.en_riesgo > 0
                                ? <span className="text-orange-600 font-medium">{a.en_riesgo}</span>
                                : <span className="text-gray-400">—</span>
                              }
                            </td>
                            <td className="px-4 py-2.5 text-right text-green-700 font-medium">
                              {fmtMoney(Number(a.sum_cargas))}
                            </td>
                            <td className="px-4 py-2.5 text-right text-red-600">
                              −{fmtMoney(Number(a.sum_retiros))}
                            </td>
                            <td className="px-4 py-2.5 text-right text-gray-500">
                              {fmtMoney(Number(a.avg_cargas))}
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-1.5">
                                <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                                  <div className="bg-green-400 h-1.5 rounded-full" style={{ width: `${pct}%` }}/>
                                </div>
                                <span className="text-xs text-gray-400 w-8 text-right">{pct}%</span>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )
            }
          </CardContent>
        </Card>

        {/* ── Reporte Financiero por Jugador ───────────────────────────── */}
        <Card className="mb-4">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <CardTitle className="text-sm font-medium">
                Reporte financiero
                {jugadores.length > 0 && !loadingJug && (
                  <span className="ml-2 text-xs font-normal text-gray-400">
                    {jugadores.length} jugadores
                  </span>
                )}
              </CardTitle>
              {jugadores.length > 0 && !loadingJug && (
                <Button variant="outline" size="sm" onClick={exportarJugadores} className="h-7 text-xs gap-1">
                  <Download size={13}/> Exportar
                </Button>
              )}
            </div>

            {/* ── Panel de búsqueda ─────────────────────────────────────── */}
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-3">
              {/* Botones rápidos de período */}
              <div className="flex flex-wrap gap-1.5">
                {([
                  { key: 'hoy',          label: 'Hoy'          },
                  { key: 'ayer',         label: 'Ayer'         },
                  { key: 'semana',       label: 'Última Semana'},
                  { key: 'mes_anterior', label: 'Mes Anterior' },
                  { key: 'mes_actual',   label: 'Mes Actual'   },
                ] as const).map(({ key, label }) => {
                  const isActive = (() => {
                    const hoy = new Date(); const t = (d: Date) => toISODate(d)
                    if (key === 'hoy')          return inputFechaDesde === t(hoy)  && inputFechaHasta === t(hoy)
                    if (key === 'ayer')          { const a = new Date(hoy); a.setDate(hoy.getDate()-1); return inputFechaDesde === t(a) && inputFechaHasta === t(a) }
                    if (key === 'semana')         { const i = new Date(hoy); i.setDate(hoy.getDate()-6); return inputFechaDesde === t(i) && inputFechaHasta === t(hoy) }
                    if (key === 'mes_anterior')   { const p = new Date(hoy.getFullYear(), hoy.getMonth()-1,1); const u = new Date(hoy.getFullYear(),hoy.getMonth(),0); return inputFechaDesde===t(p)&&inputFechaHasta===t(u) }
                    if (key === 'mes_actual')     { const p = new Date(hoy.getFullYear(), hoy.getMonth(),1); return inputFechaDesde===t(p)&&inputFechaHasta===t(hoy) }
                    return false
                  })()
                  return (
                    <button
                      key={key}
                      onClick={() => aplicarRapido(key)}
                      className={`text-xs px-3 py-1 rounded border transition-colors ${
                        isActive
                          ? 'bg-gray-800 text-white border-gray-800'
                          : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
                      }`}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>

              {/* Inputs de fecha + búsqueda + nivel */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                <div>
                  <p className="text-xs text-gray-400 mb-1">Fecha Desde</p>
                  <Input
                    type="date"
                    value={inputFechaDesde}
                    onChange={e => setInputFechaDesde(e.target.value)}
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">Fecha Hasta</p>
                  <Input
                    type="date"
                    value={inputFechaHasta}
                    onChange={e => setInputFechaHasta(e.target.value)}
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">Jugador</p>
                  <Input
                    type="text"
                    placeholder="Buscar usuario..."
                    value={inputUsername}
                    onChange={e => setInputUsername(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleBuscar()}
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-1">Rango</p>
                  <Select value={inputNivel} onValueChange={v => setInputNivel(v ?? '__all__')}>
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue placeholder="Todos los rangos"/>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">Todos los rangos</SelectItem>
                      <SelectItem value="vip">Platino</SelectItem>
                      <SelectItem value="alto">Oro</SelectItem>
                      <SelectItem value="medio">Plata</SelectItem>
                      <SelectItem value="bajo">Bronce</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Botones de acción */}
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={handleBuscar} className="h-8 text-xs gap-1.5">
                  <Search size={13}/> Buscar
                </Button>
                {filtrosActivos && (
                  <button
                    onClick={handleLimpiar}
                    className="text-xs text-gray-400 hover:text-gray-600 underline"
                  >
                    Limpiar filtros
                  </button>
                )}
                {filtrosActivos && (
                  <span className="text-xs text-blue-600 bg-blue-50 border border-blue-100 rounded px-2 py-0.5">
                    Filtros activos
                  </span>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {/* Tarjetas financieras */}
            {jugadores.length > 0 && !loadingJug && (
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="rounded-lg bg-green-50 border border-green-100 px-4 py-3">
                  <p className="text-xs text-green-600 font-medium mb-0.5">Σ Cargas</p>
                  <p className="text-xl font-bold text-green-700">{fmtMoney(finCargas)}</p>
                  <p className="text-xs text-green-500 mt-0.5">{jugadores.reduce((s,j) => s + j.cant_cargas, 0).toLocaleString('es-AR')} operaciones</p>
                </div>
                <div className="rounded-lg bg-red-50 border border-red-100 px-4 py-3">
                  <p className="text-xs text-red-600 font-medium mb-0.5">Σ Retiros</p>
                  <p className="text-xl font-bold text-red-700">−{fmtMoney(finRetiros)}</p>
                  <p className="text-xs text-red-400 mt-0.5">{jugadores.reduce((s,j) => s + j.cant_retiros, 0).toLocaleString('es-AR')} operaciones</p>
                </div>
                <div className={`rounded-lg border px-4 py-3 ${finNeto >= 0 ? 'bg-blue-50 border-blue-100' : 'bg-orange-50 border-orange-100'}`}>
                  <p className={`text-xs font-medium mb-0.5 ${finNeto >= 0 ? 'text-blue-600' : 'text-orange-600'}`}>Neto</p>
                  <p className={`text-xl font-bold ${finNeto >= 0 ? 'text-blue-700' : 'text-orange-700'}`}>
                    {finNeto >= 0 ? '' : '−'}{fmtMoney(Math.abs(finNeto))}
                  </p>
                  <p className={`text-xs mt-0.5 ${finNeto >= 0 ? 'text-blue-400' : 'text-orange-400'}`}>
                    {finNeto >= 0 ? 'Ganancia neta' : 'Deficit neto'}
                  </p>
                </div>
              </div>
            )}

            {loadingJug
              ? <p className="text-sm text-gray-400 py-4 text-center">Cargando...</p>
              : jugadores.length === 0
              ? <p className="text-sm text-gray-400 py-4">Sin jugadores para el filtro seleccionado.</p>
              : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">Usuario</th>
                        <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">Agente</th>
                        <th className="text-right px-3 py-2 text-xs font-medium text-green-600">Cargas</th>
                        <th className="text-right px-3 py-2 text-xs font-medium text-gray-400">#</th>
                        <th className="text-right px-3 py-2 text-xs font-medium text-red-500">Retiros</th>
                        <th className="text-right px-3 py-2 text-xs font-medium text-gray-400">#</th>
                        <th className="text-right px-3 py-2 text-xs font-medium text-blue-600">Neto</th>
                        <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">Nivel</th>
                        <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">Estado</th>
                        <th className="text-right px-3 py-2 text-xs font-medium text-gray-500">Días sin mov.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {jugadores.map((j, i) => {
                        const neto = Number(j.neto)
                        return (
                          <tr key={i} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                            <td className="px-3 py-2 font-mono text-xs">{j.username}</td>
                            <td className="px-3 py-2 text-gray-500 text-xs">{j.agente}</td>
                            <td className="px-3 py-2 text-right text-green-700 font-medium">
                              {fmtMoney(Number(j.total_cargas))}
                            </td>
                            <td className="px-3 py-2 text-right text-gray-400 text-xs">{j.cant_cargas}</td>
                            <td className="px-3 py-2 text-right text-red-600 font-medium">
                              −{fmtMoney(Number(j.total_retiros))}
                            </td>
                            <td className="px-3 py-2 text-right text-gray-400 text-xs">{j.cant_retiros}</td>
                            <td className={`px-3 py-2 text-right font-semibold ${neto >= 0 ? 'text-blue-700' : 'text-orange-600'}`}>
                              {neto >= 0 ? '' : '−'}{fmtMoney(Math.abs(neto))}
                            </td>
                            <td className="px-3 py-2">
                              {j.seg_monto && (
                                <Badge className={`text-xs ${NIVEL_STYLE[j.seg_monto] ?? 'bg-gray-100 text-gray-600'}`}>
                                  {NIVEL_LABEL[j.seg_monto] ?? j.seg_monto}
                                </Badge>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              {j.seg_actividad && (
                                <Badge className={`text-xs ${ACTIVIDAD_STYLE[j.seg_actividad] ?? 'bg-gray-100 text-gray-600'}`}>
                                  {j.seg_actividad}
                                </Badge>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {j.dias_ultimo != null && (
                                <span className={j.dias_ultimo > 60 ? 'text-red-600 font-medium' : j.dias_ultimo > 30 ? 'text-orange-500' : 'text-gray-600'}>
                                  {j.dias_ultimo}d
                                </span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )
            }
          </CardContent>
        </Card>

        {/* ── Seguimiento VIP / Oro ─────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">
                Seguimiento VIP / Oro
                {vipsFiltrados.length > 0 && (
                  <span className="ml-2 text-xs font-normal text-gray-400">
                    {vipsFiltrados.length} jugadores
                  </span>
                )}
              </CardTitle>
              {vipsFiltrados.length > 0 && (
                <Button variant="outline" size="sm" onClick={exportarVips} className="h-7 text-xs gap-1">
                  <Download size={13}/> Exportar
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {vipsFiltrados.length === 0
              ? <p className="text-sm text-gray-400 px-4 pb-4">Sin jugadores VIP/Oro cargados aún.</p>
              : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Usuario</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Agente</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Nivel</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Estado</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Días sin mov.</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-green-600">Cargas totales</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-gray-400">#</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-red-500">Retiros totales</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-gray-400">#</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vipsFiltrados.map((v, i) => (
                        <tr key={i} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                          <td className="px-4 py-2.5 font-mono text-xs">{v.username}</td>
                          <td className="px-4 py-2.5 text-gray-600">{v.agente}</td>
                          <td className="px-4 py-2.5">
                            <Badge className={`text-xs ${NIVEL_STYLE[v.seg_monto] ?? 'bg-gray-100 text-gray-600'}`}>
                              {NIVEL_LABEL[v.seg_monto] ?? v.seg_monto}
                            </Badge>
                          </td>
                          <td className="px-4 py-2.5">
                            <Badge className={`text-xs ${ACTIVIDAD_STYLE[v.seg_actividad] ?? 'bg-gray-100 text-gray-600'}`}>
                              {v.seg_actividad}
                            </Badge>
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <span className={v.dias_ultimo > 60 ? 'text-red-600 font-medium' : v.dias_ultimo > 30 ? 'text-orange-600' : 'text-gray-700'}>
                              {v.dias_ultimo}d
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right text-green-700 font-medium">
                            {fmtMoney(v.total_cargas)}
                          </td>
                          <td className="px-4 py-2.5 text-right text-gray-500 text-xs">{v.cant_cargas}</td>
                          <td className="px-4 py-2.5 text-right text-red-600">
                            −{fmtMoney(v.total_retiros)}
                          </td>
                          <td className="px-4 py-2.5 text-right text-gray-500 text-xs">{v.cant_retiros}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// ── Componentes auxiliares ────────────────────────────────────────────────────

function MetricCard({ icon, label, value, bad, sub }: {
  icon: React.ReactNode; label: string; value: string | number; bad?: boolean; sub?: string
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center gap-2 mb-1">{icon}<span className="text-xs text-gray-500">{label}</span></div>
        <p className={`text-2xl font-bold ${bad ? 'text-red-600' : ''}`}>{value}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  )
}

function DeltaBadge({ d, pct }: { d: number; pct: number | null }) {
  if (d === 0) return <p className="text-xs text-gray-400 mt-0.5">= vs período anterior</p>
  const up  = d > 0
  const Icon = up ? TrendingUp : TrendingDown
  return (
    <div className={`flex items-center gap-1 mt-0.5 text-xs font-medium ${up ? 'text-green-600' : 'text-red-500'}`}>
      <Icon size={12}/>
      {up ? '+' : ''}{d}
      {pct !== null && <span className="font-normal text-gray-400">({up ? '+' : ''}{pct}%)</span>}
      <span className="font-normal text-gray-400">vs período anterior</span>
    </div>
  )
}
