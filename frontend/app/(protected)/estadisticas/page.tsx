'use client'

import { PageHeader } from '@/components/layout/PageHeader'
import { argentinaToday, shiftDate, formatPesos } from '@/lib/dashboard-format'
import { CampaignEffectivenessPanel } from '@/components/campaigns/CampaignEffectivenessPanel'
import type { CampaignEffectiveness, EffectiveRecipient } from '@/lib/campaign-effectiveness'
import { useEffect, useState, useCallback, useRef } from 'react'
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Loader2, Download, RefreshCw, AlertCircle, TrendingUp, TrendingDown,
  Send, CheckCheck, Eye, MessageSquare, X, BarChart2, Bot, Sparkles,
} from 'lucide-react'

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface OverviewKPIs {
  enviados: number; respuestas: number; entregados: number
  leidos: number; fallidos: number
  tasa_entrega: string; tasa_lectura: string; tasa_respuesta: string
}
interface SeriesPoint { dia: string; enviados: number; entregados: number; leidos: number; respuestas: number }
interface DistPoint   { status: string; n: number }
interface TopCampaign { id: string; name: string; type: string; status: string; total: number; leidos: number }
interface CampaignCount { total: number; completadas: number; activas: number; programadas: number }

interface Campaign extends CampaignEffectiveness {
  id: string; name: string; type: string; status: string
  created_at: string; completed_at: string | null
  enviados: number; entregados: number; leidos: number; fallidos: number; respuestas: number
  tasa_entrega: string | null; tasa_lectura: string | null
}
interface CampaignDetail {
  kpis: Omit<CampaignEffectiveness, 'efectivos_detalle'> & { enviados: number; entregados: number; leidos: number; fallidos: number; respuestas: number; tasa_entrega: string; tasa_lectura: string }
  efectivos: EffectiveRecipient[]
  series: SeriesPoint[]
}
interface LineStats {
  id: string; line_key: string; display_name: string; phone_number: string | null
  status: string; is_connected: boolean
  msgs_sent_today: number; msg_per_day: number
  total_sent: number; total_failed: number; total_delivered: number
  tasa_entrega: string | null; tasa_error: string | null; last_seen_at: string | null
}
interface TemplateStats {
  id: string; name: string; category: string; language: string; status: string
  usage_count: number; last_used_at: string | null
  enviados: number; leidos: number; respuestas: number; tasa_lectura: string | null
}

// ── Constantes ────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  sent:      '#60a5fa',
  delivered: '#34d399',
  read:      '#a78bfa',
  failed:    '#f87171',
  queued:    '#94a3b8',
  skipped:   '#cbd5e1',
  received:  '#fbbf24',
}

const STATUS_LABEL: Record<string, string> = {
  sent:      'Enviado',
  delivered: 'Entregado',
  read:      'Leído',
  failed:    'Fallido',
  queued:    'En cola',
  skipped:   'Omitido',
  received:  'Recibido',
}

const CAMPAIGN_STATUS_STYLE: Record<string, string> = {
  draft:     'bg-muted text-muted-foreground',
  scheduled: 'bg-blue-100 text-blue-700',
  running:   'bg-success/15 text-success',
  paused:    'bg-yellow-100 text-yellow-700',
  completed: 'bg-purple-100 text-purple-700',
  cancelled: 'bg-destructive/15 text-destructive',
}
const CAMPAIGN_STATUS_LABEL: Record<string, string> = {
  draft:'Borrador', scheduled:'Programada', running:'Enviando',
  paused:'Pausada', completed:'Completada', cancelled:'Cancelada',
}

const LINE_STATUS_STYLE: Record<string, string> = {
  active:'bg-success/15 text-success', paused:'bg-yellow-100 text-yellow-700',
  error:'bg-destructive/15 text-destructive', offline:'bg-muted text-muted-foreground',
}

const CHART_LINES = [
  { key: 'enviados',   name: 'Enviados',    color: '#60a5fa' },
  { key: 'entregados', name: 'Entregados',  color: '#34d399' },
  { key: 'leidos',     name: 'Leídos',      color: '#a78bfa' },
  { key: 'respuestas', name: 'Respuestas',  color: '#fbbf24' },
]

function fmt(n: number | null | undefined): string {
  if (n == null) return '—'
  return Number(n).toLocaleString('es-AR')
}
function pct(v: string | null | undefined): string {
  if (v == null || v === '') return '—'
  return `${v}%`
}
function fmtDate(s: string | null): string {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', timeZone:'America/Argentina/Buenos_Aires' })
}
function fmtDia(s: string): string {
  const [, m, d] = s.split('-')
  return `${d}/${m}`
}

// ── Date range helpers ────────────────────────────────────────────────────────

function today() { return argentinaToday() }
function daysAgo(n: number) { return shiftDate(today(), -n) }
function startOfMonth() {
  return today().slice(0, 8) + '01'
}

const PRESETS = [
  { label: 'Hoy',           from: () => today(),        to: () => today() },
  { label: 'Ayer',          from: () => daysAgo(1),     to: () => daysAgo(1) },
  { label: 'Últimos 7 días',  from: () => daysAgo(6),  to: () => today() },
  { label: 'Últimos 30 días', from: () => daysAgo(29), to: () => today() },
  { label: 'Este mes',      from: startOfMonth,          to: () => today() },
]

// ── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, icon: Icon, color = 'blue' }: {
  label: string; value: string | number; sub?: string
  icon: React.ElementType; color?: string
}) {
  const colors: Record<string, string> = {
    blue:   'bg-blue-50 text-blue-600',
    green:  'bg-success/10 text-success',
    purple: 'bg-purple-50 text-purple-600',
    amber:  'bg-warning/10 text-amber-600',
    red:    'bg-destructive/10 text-destructive',
    slate:  'bg-background text-slate-600',
  }
  return (
    <Card className="border border-border">
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</p>
            <p className="text-2xl font-bold text-foreground mt-1">{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
          </div>
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${colors[color]}`}>
            <Icon size={18} />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function EstadisticasPage() {
  // Date range
  const [preset,  setPreset]  = useState(3) // "Últimos 30 días"
  const [from,    setFrom]    = useState(daysAgo(29))
  const [to,      setTo]      = useState(today())
  const [custom,  setCustom]  = useState(false)

  // Overview data
  const [kpis,          setKpis]          = useState<OverviewKPIs | null>(null)
  const [series,        setSeries]        = useState<SeriesPoint[]>([])
  const [distribution,  setDistribution]  = useState<DistPoint[]>([])
  const [topCampaigns,  setTopCampaigns]  = useState<TopCampaign[]>([])
  const [campaignCount, setCampaignCount] = useState<CampaignCount | null>(null)
  const [loadingOv,     setLoadingOv]     = useState(true)
  const [errorOv,       setErrorOv]       = useState<string | null>(null)

  // Campaigns tab
  const [campaigns,    setCampaigns]    = useState<Campaign[]>([])
  const [loadingCamp,  setLoadingCamp]  = useState(false)
  const [errorCamp,    setErrorCamp]    = useState<string | null>(null)
  const [campStatus,   setCampStatus]   = useState('')
  const [campQ,        setCampQ]        = useState('')
  const [detail,       setDetail]       = useState<string | null>(null)
  const [detailData,   setDetailData]   = useState<CampaignDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const detailRequest = useRef(0)

  // Lines tab
  const [lines,      setLines]      = useState<LineStats[]>([])
  const [loadingLn,  setLoadingLn]  = useState(false)
  const [errorLn,    setErrorLn]    = useState<string | null>(null)

  // Templates tab
  const [templates,  setTemplates]  = useState<TemplateStats[]>([])
  const [loadingTpl, setLoadingTpl] = useState(false)
  const [errorTpl,   setErrorTpl]   = useState<string | null>(null)

  // Export
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  // AI Chat tab
  interface AiMessage { role: 'user' | 'assistant'; content: string }
  const [aiMessages,  setAiMessages]  = useState<AiMessage[]>([])
  const [aiInput,     setAiInput]     = useState('')
  const [aiLoading,   setAiLoading]   = useState(false)
  const [aiError,     setAiError]     = useState<string | null>(null)
  const aiBottomRef = useRef<HTMLDivElement>(null)

  // Active tab
  const [tab, setTab] = useState('resumen')

  // ── Fetch overview ───────────────────────────────────────────────────────

  const loadOverview = useCallback(async () => {
    setLoadingOv(true); setErrorOv(null)
    try {
      const res  = await fetch(`/api/stats/overview?from=${from}&to=${to}`)
      const data = await res.json() as {
        kpis?: OverviewKPIs; series?: SeriesPoint[]
        distribution?: DistPoint[]; topCampaigns?: TopCampaign[]
        campaignCount?: CampaignCount; error?: string
      }
      if (!res.ok) { setErrorOv(data.error || `Error ${res.status}`); return }
      setKpis(data.kpis ?? null)
      setSeries(data.series ?? [])
      setDistribution(data.distribution ?? [])
      setTopCampaigns(data.topCampaigns ?? [])
      setCampaignCount(data.campaignCount ?? null)
    } catch { setErrorOv('Error de red') } finally { setLoadingOv(false) }
  }, [from, to])

  const loadCampaigns = useCallback(async () => {
    setLoadingCamp(true); setErrorCamp(null)
    const params = new URLSearchParams({ from, to, status: campStatus, q: campQ })
    try {
      const res  = await fetch(`/api/stats/campaigns?${params}`)
      const data = await res.json() as { campaigns?: Campaign[]; error?: string }
      if (!res.ok) { setErrorCamp(data.error || `Error ${res.status}`); return }
      setCampaigns(data.campaigns ?? [])
    } catch { setErrorCamp('Error de red') } finally { setLoadingCamp(false) }
  }, [from, to, campStatus, campQ])

  const loadLines = useCallback(async () => {
    setLoadingLn(true); setErrorLn(null)
    try {
      const res  = await fetch('/api/stats/lines')
      const data = await res.json() as { lines?: LineStats[]; error?: string }
      if (!res.ok) { setErrorLn(data.error || `Error ${res.status}`); return }
      setLines(data.lines ?? [])
    } catch { setErrorLn('Error de red') } finally { setLoadingLn(false) }
  }, [])

  const loadTemplates = useCallback(async () => {
    setLoadingTpl(true); setErrorTpl(null)
    try {
      const res  = await fetch(`/api/stats/templates?from=${from}&to=${to}`)
      const data = await res.json() as { templates?: TemplateStats[]; error?: string }
      if (!res.ok) { setErrorTpl(data.error || `Error ${res.status}`); return }
      setTemplates(data.templates ?? [])
    } catch { setErrorTpl('Error de red') } finally { setLoadingTpl(false) }
  }, [from, to])

  const loadDetail = useCallback(async (id: string) => {
    const request = ++detailRequest.current
    setLoadingDetail(true); setDetailData(null); setErrorDetail(null)
    try {
      const res  = await fetch(`/api/stats/campaigns?id=${id}&from=${from}&to=${to}`)
      const data = await res.json() as CampaignDetail & { error?: string }
      if (request !== detailRequest.current) return
      if (!res.ok) { setErrorDetail(data.error || 'No se pudo cargar la campaña'); return }
      setDetailData(data)
    } catch { if (request === detailRequest.current) setErrorDetail('Error de red al cargar la campaña') }
    finally { if (request === detailRequest.current) setLoadingDetail(false) }
  }, [from, to])

  useEffect(() => { void loadOverview() }, [loadOverview])
  useEffect(() => { if (tab === 'campanas') void loadCampaigns() }, [tab, loadCampaigns])
  useEffect(() => { if (tab === 'lineas')   void loadLines()     }, [tab, loadLines])
  useEffect(() => { if (tab === 'plantillas') void loadTemplates() }, [tab, loadTemplates])

  useEffect(() => {
    if (detail) void loadDetail(detail)
  }, [detail, loadDetail])

  // Preset handler
  function applyPreset(i: number) {
    setPreset(i); setCustom(false)
    setFrom(PRESETS[i].from()); setTo(PRESETS[i].to())
  }

  // AI Chat handler
  async function sendAiMessage(text?: string) {
    const content = (text ?? aiInput).trim()
    if (!content || aiLoading) return
    setAiInput('')
    setAiError(null)
    const updated: AiMessage[] = [...aiMessages, { role: 'user', content }]
    setAiMessages(updated)
    setAiLoading(true)
    setTimeout(() => aiBottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    try {
      const res = await fetch('/api/stats/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: updated }),
      })
      const data = await res.json() as { response?: string; error?: string }
      if (!res.ok || data.error) { setAiError(data.error ?? `Error ${res.status}`); return }
      setAiMessages(prev => [...prev, { role: 'assistant', content: data.response ?? '' }])
    } catch { setAiError('Error de red') } finally {
      setAiLoading(false)
      setTimeout(() => aiBottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    }
  }

  // Export handler
  async function handleExport(type: string) {
    setExporting(true); setExportError(null)
    try {
      const params = new URLSearchParams({from,to,type})
      if(type==='campaigns') {params.set('status',campStatus);params.set('q',campQ)}
      const res = await fetch('/api/stats/export?'+params)
      if (!res.ok) {const data=await res.json().catch(()=>null);setExportError(data?.error||'No se pudo exportar');return}
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a'); a.href = url
      a.download = `estadisticas_${type}_${from}_${to}.csv`; a.click()
      URL.revokeObjectURL(url)
    } catch {setExportError('No se pudo descargar el archivo')} finally { setExporting(false) }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      {exportError && <p role="alert" className="text-sm text-destructive">{exportError}</p>}
      {/* Header */}
      <PageHeader title="Estadísticas" className="mb-0"
        description="Métricas en hora argentina. Campañas: resultado actual por destinatario; Resumen: actividad del período." />
      <div className="filter-bar">
        {/* Presets */}
        <div className="flex max-w-full flex-wrap gap-1 bg-muted rounded-lg p-1">
          {PRESETS.map((p, i) => (
            <button key={p.label} onClick={() => applyPreset(i)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                preset === i && !custom ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}>
              {p.label}
            </button>
          ))}
        </div>
        {/* Custom date range */}
        <div className="flex items-center gap-1">
          <Input aria-label="Estadísticas desde" type="date" value={from} max={to}
            onChange={e => { setFrom(e.target.value); setCustom(true); setPreset(-1) }}
            className="h-8 text-xs w-36" />
          <span className="text-muted-foreground text-xs">→</span>
          <Input aria-label="Estadísticas hasta" type="date" value={to} min={from}
            onChange={e => { setTo(e.target.value); setCustom(true); setPreset(-1) }}
            className="h-8 text-xs w-36" />
        </div>
        <Button variant="ghost" size="sm" onClick={() => { void loadOverview(); if (tab === 'campanas') { void loadCampaigns(); if (detail) void loadDetail(detail) } }} className="h-8">
          <RefreshCw size={13} aria-label="Actualizar estadísticas" />
        </Button>
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="resumen">Resumen</TabsTrigger>
          <TabsTrigger value="campanas">Campañas</TabsTrigger>
          <TabsTrigger value="lineas">Líneas</TabsTrigger>
          <TabsTrigger value="plantillas">Plantillas</TabsTrigger>
          <TabsTrigger value="ia" className="flex items-center gap-1.5">
            <Sparkles size={13} />IA Analytics
          </TabsTrigger>
        </TabsList>

        {/* ── TAB: RESUMEN ─────────────────────────────────────────────────── */}
        <TabsContent value="resumen" className="space-y-5 mt-4">
          {loadingOv ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 size={24} className="animate-spin text-muted-foreground/60" />
            </div>
          ) : errorOv ? (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3">
              <AlertCircle size={15} /> {errorOv}
            </div>
          ) : (
            <>
              {/* KPIs */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <KpiCard label="Mensajes enviados" value={fmt(kpis?.enviados)}    icon={Send}         color="blue" />
                <KpiCard label="Tasa de entrega"   value={pct(kpis?.tasa_entrega)} icon={CheckCheck}   color="green" />
                <KpiCard label="Tasa de lectura"   value={pct(kpis?.tasa_lectura)} icon={Eye}          color="purple" />
                <KpiCard label="Tasa de respuesta" value={pct(kpis?.tasa_respuesta)} icon={MessageSquare} color="amber" />
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <KpiCard label="Entregados"   value={fmt(kpis?.entregados)} icon={CheckCheck}    color="green" />
                <KpiCard label="Leídos"       value={fmt(kpis?.leidos)}     icon={Eye}           color="purple" />
                <KpiCard label="Respuestas"   value={fmt(kpis?.respuestas)} icon={MessageSquare} color="amber" />
                <KpiCard label="Fallidos"     value={fmt(kpis?.fallidos)}   icon={AlertCircle}   color="red" />
              </div>

              {/* Gráfico: evolución temporal */}
              <Card className="border border-border">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-medium text-foreground">Evolución de mensajes</CardTitle>
                    <button onClick={() => void handleExport('overview')} disabled={exporting}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-muted-foreground">
                      <Download size={12} />
                      {exporting ? 'Exportando…' : 'CSV'}
                    </button>
                  </div>
                </CardHeader>
                <CardContent>
                  {series.length === 0 ? (
                    <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">
                      <BarChart2 size={32} className="mr-2 opacity-30" /> Sin datos en este período
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height={240}>
                      <LineChart data={series} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                        <XAxis dataKey="dia" tickFormatter={fmtDia} tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip formatter={(v) => typeof v === 'number' ? v.toLocaleString('es-AR') : v} labelFormatter={(s) => fmtDia(String(s))} />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        {CHART_LINES.map(l => (
                          <Line key={l.key} type="monotone" dataKey={l.key} name={l.name}
                            stroke={l.color} strokeWidth={2} dot={false} />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Distribución por estado */}
                <Card className="border border-border">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-foreground">Distribución por estado</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {distribution.length === 0 ? (
                      <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">Sin datos</div>
                    ) : (
                      <div className="flex items-center gap-4">
                        <ResponsiveContainer width={160} height={160}>
                          <PieChart>
                            <Pie data={distribution} dataKey="n" nameKey="status" cx="50%" cy="50%" outerRadius={70} innerRadius={40}>
                              {distribution.map((d, i) => (
                                <Cell key={i} fill={STATUS_COLORS[d.status] ?? '#94a3b8'} />
                              ))}
                            </Pie>
                            <Tooltip formatter={(v) => typeof v === 'number' ? v.toLocaleString('es-AR') : v} labelFormatter={(s) => STATUS_LABEL[String(s)] ?? String(s)} />
                          </PieChart>
                        </ResponsiveContainer>
                        <div className="flex flex-col gap-2 flex-1">
                          {distribution.map(d => (
                            <div key={d.status} className="flex items-center justify-between text-xs">
                              <div className="flex items-center gap-1.5">
                                <div className="w-2.5 h-2.5 rounded-full" style={{ background: STATUS_COLORS[d.status] ?? '#94a3b8' }} />
                                <span className="text-muted-foreground">{STATUS_LABEL[d.status] ?? d.status}</span>
                              </div>
                              <span className="font-medium text-foreground">{d.n.toLocaleString('es-AR')}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Top campañas */}
                <Card className="border border-border">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-foreground">Top campañas por volumen</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {topCampaigns.length === 0 ? (
                      <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">Sin datos</div>
                    ) : (
                      <ResponsiveContainer width="100%" height={180}>
                        <BarChart data={topCampaigns} layout="vertical" margin={{ top: 0, right: 10, left: 10, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f0f0f0" />
                          <XAxis type="number" tick={{ fontSize: 10 }} />
                          <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 10 }}
                            tickFormatter={(s: string) => s.length > 14 ? s.slice(0, 14) + '…' : s} />
                          <Tooltip formatter={(v) => typeof v === 'number' ? v.toLocaleString('es-AR') : v} />
                          <Bar dataKey="total" name="Enviados" fill="#60a5fa" radius={[0, 4, 4, 0]} />
                          <Bar dataKey="leidos" name="Leídos"   fill="#a78bfa" radius={[0, 4, 4, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Resumen campañas */}
              {campaignCount && (
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  {[
                    { label: 'Campañas totales',    value: campaignCount.total,       color: 'text-foreground' },
                    { label: 'Completadas',         value: campaignCount.completadas, color: 'text-purple-700' },
                    { label: 'En envío',            value: campaignCount.activas,     color: 'text-success' },
                    { label: 'Programadas',         value: campaignCount.programadas, color: 'text-blue-700' },
                  ].map(item => (
                    <Card key={item.label} className="border border-border">
                      <CardContent className="p-4 text-center">
                        <p className={`text-2xl font-bold ${item.color}`}>{item.value}</p>
                        <p className="text-xs text-muted-foreground mt-1">{item.label}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </>
          )}
        </TabsContent>

        {/* ── TAB: CAMPAÑAS ────────────────────────────────────────────────── */}
        <TabsContent value="campanas" className="space-y-4 mt-4">
          <p className="text-xs text-muted-foreground">Respuestas cuenta mensajes recibidos, no personas únicas. Se asignan al mensaje citado o al último envío de campaña de esa conversación.</p>
          <p className="text-xs text-muted-foreground">Efectivos: destinatarios con una carga confirmada dentro de las 24 horas posteriores a su envío. Los montos corresponden a cargas, sin bonos.</p>
          {detail ? (
            /* DETALLE DE CAMPAÑA */
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <button onClick={() => { setDetail(null); setDetailData(null) }}
                  className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
                  <X size={14} /> Volver a campañas
                </button>
                <span className="text-muted-foreground/60">|</span>
                <span className="text-sm font-medium text-foreground">
                  {campaigns.find(c => c.id === detail)?.name ?? detail}
                </span>
              </div>
              {loadingDetail ? (
                <div className="flex items-center justify-center h-40">
                  <Loader2 size={20} className="animate-spin text-muted-foreground/60" />
                </div>
              ) : errorDetail ? (
                <p role="alert" className="text-sm text-destructive">{errorDetail}</p>
              ) : detailData ? (
                <>
                  <CampaignEffectivenessPanel key={detail} stats={detailData.kpis} recipients={detailData.efectivos} />
                  <div className="grid grid-cols-2 xl:grid-cols-5 gap-4">
                    <KpiCard label="Enviados"   value={fmt(detailData.kpis.enviados)}   icon={Send}         color="blue" />
                    <KpiCard label="Entregados" value={fmt(detailData.kpis.entregados)} icon={CheckCheck}   color="green"
                      sub={pct(detailData.kpis.tasa_entrega) + ' tasa entrega'} />
                    <KpiCard label="Leídos"     value={fmt(detailData.kpis.leidos)}     icon={Eye}          color="purple"
                      sub={pct(detailData.kpis.tasa_lectura) + ' tasa lectura'} />
                    <KpiCard label="Respuestas" value={fmt(detailData.kpis.respuestas)} icon={MessageSquare} color="amber"
                      sub="Mensajes recibidos" />
                    <KpiCard label="Fallidos"   value={fmt(detailData.kpis.fallidos)}   icon={AlertCircle}  color="red" />
                  </div>
                  <Card className="border border-border">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-foreground">Evolución diaria</CardTitle>
                    </CardHeader>
                    <CardContent>
                      {detailData.series.length === 0 ? (
                        <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">Sin datos</div>
                      ) : (
                        <ResponsiveContainer width="100%" height={220}>
                          <LineChart data={detailData.series} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                            <XAxis dataKey="dia" tickFormatter={fmtDia} tick={{ fontSize: 11 }} />
                            <YAxis tick={{ fontSize: 11 }} />
                            <Tooltip formatter={(v) => typeof v === 'number' ? v.toLocaleString('es-AR') : v} labelFormatter={(s) => fmtDia(String(s))} />
                            <Legend wrapperStyle={{ fontSize: 12 }} />
                            <Line type="monotone" dataKey="enviados"   name="Enviados"   stroke="#60a5fa" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="entregados" name="Entregados" stroke="#34d399" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="leidos"     name="Leídos"     stroke="#a78bfa" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="respuestas" name="Respuestas" stroke="#fbbf24" strokeWidth={2} dot={detailData.series.length === 1} />
                          </LineChart>
                        </ResponsiveContainer>
                      )}
                    </CardContent>
                  </Card>
                </>
              ) : null}
            </div>
          ) : (
            /* LISTA DE CAMPAÑAS */
            <>
              <div className="flex gap-2 flex-wrap">
                <Input placeholder="Buscar campaña…" value={campQ}
                  onChange={e => setCampQ(e.target.value)} className="h-8 text-sm w-52" />
                <Select value={campStatus || 'all'} onValueChange={(v: string | null) => setCampStatus(!v || v === 'all' ? '' : v)}>
                  <SelectTrigger className="h-8 text-sm w-40"><SelectValue placeholder="Estado" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos los estados</SelectItem>
                    {Object.entries(CAMPAIGN_STATUS_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button variant="ghost" size="sm" onClick={() => void loadCampaigns()} className="h-8">
                  <RefreshCw size={13} aria-label="Actualizar estadísticas" />
                </Button>
                <Button variant="outline" size="sm" onClick={() => void handleExport('campaigns')}
                  disabled={exporting} className="h-8 text-xs gap-1 ml-auto">
                  <Download size={12} /> {exporting ? 'Exportando…' : 'Exportar CSV'}
                </Button>
              </div>
              {loadingCamp ? (
                <div className="flex items-center justify-center h-40"><Loader2 size={20} className="animate-spin text-muted-foreground/60" /></div>
              ) : errorCamp ? (
                <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 rounded-lg px-4 py-3">
                  <AlertCircle size={15} /> {errorCamp}
                </div>
              ) : campaigns.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground text-sm">Sin campañas en este período</div>
              ) : (
                <div className="border border-border rounded-xl overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-background border-b border-border">
                      <tr>
                        {['Campaña','Estado','Enviados','Efectivos (24 h)','Efectividad','Monto cargado (24 h)','Entregados','Leídos','Respuestas','Fallidos','T. entrega','T. lectura','Creada'].map(h => (
                          <th key={h} className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {campaigns.map(c => (
                        <tr key={c.id} className="hover:bg-background cursor-pointer" onClick={() => setDetail(c.id)}>
                          <td className="px-4 py-3 font-medium text-foreground max-w-[160px] truncate">{c.name}</td>
                          <td className="px-4 py-3">
                            <Badge className={CAMPAIGN_STATUS_STYLE[c.status] ?? ''}>
                              {CAMPAIGN_STATUS_LABEL[c.status] ?? c.status}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-foreground">{fmt(c.enviados)}</td>
                          <td className="px-4 py-3 text-success">{fmt(c.efectivos)}</td>
                          <td className="px-4 py-3 text-foreground">
                            {pct(c.tasa_efectividad)}
                            {c.ventanas_abiertas > 0 && <span className="block text-xs text-muted-foreground">Provisional</span>}
                          </td>
                          <td className="px-4 py-3 text-foreground whitespace-nowrap">{formatPesos(c.monto_cargado_24h)}</td>
                          <td className="px-4 py-3 text-foreground">{fmt(c.entregados)}</td>
                          <td className="px-4 py-3 text-foreground">{fmt(c.leidos)}</td>
                          <td className="px-4 py-3 text-foreground">{fmt(c.respuestas)}</td>
                          <td className="px-4 py-3 text-red-500">{fmt(c.fallidos)}</td>
                          <td className="px-4 py-3 text-muted-foreground">{pct(c.tasa_entrega)}</td>
                          <td className="px-4 py-3 text-muted-foreground">{pct(c.tasa_lectura)}</td>
                          <td className="px-4 py-3 text-muted-foreground text-xs">{fmtDate(c.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </TabsContent>

        {/* ── TAB: LÍNEAS ──────────────────────────────────────────────────── */}
        <TabsContent value="lineas" className="space-y-4 mt-4">
          {loadingLn ? (
            <div className="flex items-center justify-center h-40"><Loader2 size={20} className="animate-spin text-muted-foreground/60" /></div>
          ) : errorLn ? (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 rounded-lg px-4 py-3">
              <AlertCircle size={15} /> {errorLn}
            </div>
          ) : lines.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">Sin líneas configuradas</div>
          ) : (
            <>
              {/* BarChart de líneas */}
              <Card className="border border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-foreground">Mensajes totales por línea</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={lines.slice(0, 12)} margin={{ top: 5, right: 10, left: -20, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="display_name" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" />
                      <YAxis tick={{ fontSize: 10 }} />
                      <Tooltip formatter={(v) => typeof v === 'number' ? v.toLocaleString('es-AR') : v} />
                      <Bar dataKey="total_sent"      name="Enviados"   fill="#60a5fa" radius={[4,4,0,0]} />
                      <Bar dataKey="total_delivered" name="Entregados" fill="#34d399" radius={[4,4,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Tabla */}
              <div className="border border-border rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-background border-b border-border">
                    <tr>
                      {['Línea','Estado','Hoy','Capacidad/día','Total enviados','Entregados','Fallidos','T. entrega','T. error'].map(h => (
                        <th key={h} className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {lines.map(l => (
                      <tr key={l.id} className="hover:bg-background">
                        <td className="px-4 py-3">
                          <p className="font-medium text-foreground">{l.display_name}</p>
                          {l.phone_number && <p className="text-xs text-muted-foreground">{l.phone_number}</p>}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <div className={`w-1.5 h-1.5 rounded-full ${l.is_connected ? 'bg-green-500' : 'bg-gray-300'}`} />
                            <Badge className={LINE_STATUS_STYLE[l.status] ?? 'bg-muted text-muted-foreground'}>
                              {l.status}
                            </Badge>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-foreground">{fmt(l.msgs_sent_today)}</td>
                        <td className="px-4 py-3 text-muted-foreground">{fmt(l.msg_per_day)}</td>
                        <td className="px-4 py-3 text-foreground">{fmt(l.total_sent)}</td>
                        <td className="px-4 py-3 text-foreground">{fmt(l.total_delivered)}</td>
                        <td className="px-4 py-3 text-red-500">{fmt(l.total_failed)}</td>
                        <td className="px-4 py-3 text-muted-foreground">{pct(l.tasa_entrega)}</td>
                        <td className="px-4 py-3 text-muted-foreground">{pct(l.tasa_error)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </TabsContent>

        {/* ── TAB: PLANTILLAS ──────────────────────────────────────────────── */}
        <TabsContent value="plantillas" className="space-y-4 mt-4">
          {loadingTpl ? (
            <div className="flex items-center justify-center h-40"><Loader2 size={20} className="animate-spin text-muted-foreground/60" /></div>
          ) : errorTpl ? (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 rounded-lg px-4 py-3">
              <AlertCircle size={15} /> {errorTpl}
            </div>
          ) : templates.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">Sin plantillas creadas</div>
          ) : (
            <div className="border border-border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-background border-b border-border">
                  <tr>
                    {['Plantilla','Categoría','Idioma','Estado','Usos totales','Enviados (período)','Leídos','T. lectura','Última vez'].map(h => (
                      <th key={h} className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wide whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {templates.map(t => (
                    <tr key={t.id} className="hover:bg-background">
                      <td className="px-4 py-3 font-mono text-xs font-medium text-foreground">{t.name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{t.category}</td>
                      <td className="px-4 py-3 uppercase text-xs text-muted-foreground">{t.language}</td>
                      <td className="px-4 py-3">
                        <Badge className={t.status === 'APROBADA' ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'}>
                          {t.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-foreground">{fmt(t.usage_count)}</td>
                      <td className="px-4 py-3 text-foreground">{fmt(t.enviados)}</td>
                      <td className="px-4 py-3 text-foreground">{fmt(t.leidos)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{pct(t.tasa_lectura)}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{fmtDate(t.last_used_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        {/* ── TAB: IA ANALYTICS ───────────────────────────────────────────── */}
        <TabsContent value="ia" className="mt-4">
          <div className="flex flex-col h-[calc(100vh-220px)] min-h-[500px] border border-border rounded-xl overflow-hidden bg-card">

            {/* Header */}
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border bg-background">
              <div className="w-7 h-7 rounded-lg bg-violet-100 flex items-center justify-center">
                <Bot size={14} className="text-violet-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">IA Analytics</p>
                <p className="text-xs text-muted-foreground">Hacé preguntas sobre jugadores, transacciones y campañas</p>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
              {aiMessages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full gap-6 text-center">
                  <div className="w-12 h-12 rounded-2xl bg-violet-50 flex items-center justify-center">
                    <Sparkles size={22} className="text-violet-500" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">¿Qué querés saber?</p>
                    <p className="text-xs text-muted-foreground mt-1">Hacé preguntas en lenguaje natural sobre tu base de jugadores</p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-lg">
                    {[
                      '¿Cuántos Super VIP hay por agente?',
                      '¿Cuáles son los 10 jugadores con más depósitos este mes?',
                      '¿Cuántos jugadores nuevos se registraron en los últimos 30 días?',
                      '¿Qué agente tiene más jugadores en riesgo?',
                    ].map(q => (
                      <button key={q} onClick={() => sendAiMessage(q)}
                        className="text-left px-3 py-2.5 rounded-lg border border-border bg-background hover:bg-violet-50 hover:border-violet-200 text-xs text-muted-foreground hover:text-violet-700 transition-colors">
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {aiMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'assistant' && (
                    <div className="w-6 h-6 rounded-full bg-violet-100 flex items-center justify-center mr-2 mt-0.5 shrink-0">
                      <Bot size={12} className="text-violet-600" />
                    </div>
                  )}
                  <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-violet-600 text-white rounded-br-sm'
                      : 'bg-muted text-foreground rounded-bl-sm'
                  }`}>
                    {msg.content}
                  </div>
                </div>
              ))}

              {aiLoading && (
                <div className="flex justify-start">
                  <div className="w-6 h-6 rounded-full bg-violet-100 flex items-center justify-center mr-2 mt-0.5 shrink-0">
                    <Bot size={12} className="text-violet-600" />
                  </div>
                  <div className="bg-muted rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:0ms]" />
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:300ms]" />
                  </div>
                </div>
              )}

              {aiError && (
                <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                  <AlertCircle size={13} /> {aiError}
                </div>
              )}

              <div ref={aiBottomRef} />
            </div>

            {/* Input */}
            <div className="border-t border-border px-4 py-3 bg-card">
              <form onSubmit={e => { e.preventDefault(); void sendAiMessage() }} className="flex gap-2">
                <Input
                  value={aiInput}
                  onChange={e => setAiInput(e.target.value)}
                  placeholder="Preguntá sobre jugadores, depósitos, segmentos..."
                  className="flex-1 h-9 text-sm"
                  disabled={aiLoading}
                />
                <Button type="submit" size="sm" disabled={aiLoading || !aiInput.trim()}
                  className="h-9 px-3 bg-violet-600 hover:bg-violet-700 text-white">
                  {aiLoading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                </Button>
              </form>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
