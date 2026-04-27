'use client'
import { useEffect, useState } from 'react'
import * as XLSX from 'xlsx'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  MessageSquare, Send, AlertCircle, Eye, Wifi, Clock,
  BarChart2, Shield, TrendingUp, TrendingDown, Users, Star, Download,
} from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'
import type { CasinoSummary, CasinoAgente, CasinoVip } from '@/app/api/dashboard/casino/route'

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
  const [casino, setCasino] = useState<CasinoData | null>(null)
  const [filterAgente, setFilterAgente] = useState<string>('__all__')

  useEffect(() => {
    fetchJson<{ stats: Stats; lines: Line[]; recent: Message[]; campaignStats: CampaignStats }>('/api/dashboard')
      .then(d => { setStats(d.stats); setLines(d.lines || []); setRecent(d.recent || []); setCs(d.campaignStats) })
      .catch(() => {})

    fetchJson<CasinoData>('/api/dashboard/casino')
      .then(d => setCasino(d))
      .catch(() => {})
  }, [])

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

  // Variaciones periodo anterior
  const varNuevos  = sum ? delta(sum.nuevos_mes,  sum.nuevos_anterior)  : null
  const varActivos = sum ? delta(sum.activos_mes, sum.activos_anterior) : null

  // CSV export para tabla VIP
  const exportarVips = () => {
    const rows = vipsFiltrados.map(v => ({
      'Usuario':               v.username,
      'Agente':                v.agente,
      'Nivel':                 NIVEL_LABEL[v.seg_monto] ?? v.seg_monto,
      'Estado':                v.seg_actividad,
      'Días sin movimiento':   v.dias_ultimo,
      'Gasto total acum.':     v.total_cargas,
      'Cargas':                v.cant_cargas,
      'Retiros':               v.total_retiros,
      'Último movimiento':     v.fecha_ultima,
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

      {/* ══════════════════════════════════════════════════════════════════════
          SECCIÓN: Difusión / Broadcast
          ══════════════════════════════════════════════════════════════════ */}
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Difusión
        </p>

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

      {/* ══════════════════════════════════════════════════════════════════════
          SECCIÓN: Casino / Agentes
          ══════════════════════════════════════════════════════════════════ */}
      <div>
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Casino / Agentes
        </p>

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
                        <th className="px-4 py-2 w-32 text-xs font-medium text-gray-500">Actividad</th>
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
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-1.5">
                                <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                                  <div
                                    className="bg-green-400 h-1.5 rounded-full"
                                    style={{ width: `${pct}%` }}
                                  />
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
                        <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Gasto total acum.</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-gray-500">Cargas</th>
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
                          <td className="px-4 py-2.5 text-right text-gray-700">
                            {fmtMoney(v.total_cargas)}
                          </td>
                          <td className="px-4 py-2.5 text-right text-gray-500">
                            {v.cant_cargas}
                          </td>
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
