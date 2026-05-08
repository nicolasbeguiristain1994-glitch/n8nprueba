'use client'
import { useEffect, useState, useCallback } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Flame, Loader2, AlertTriangle, CheckCircle2, Pause, Play,
  RotateCcw, Save, Zap, TrendingUp, Activity, Settings, Clock,
  RefreshCw, Shield, ShieldAlert, Bell, X,
} from 'lucide-react'
import { getDailyLimitForDay, isActiveWindow, isActiveDay } from '@/lib/warmup-engine'
import type { DelayPreset } from '@/lib/warmup-engine'
import {
  healthScore, healthColor, healthLabel, fmtPhone, timeAgo,
  STATUS_CFG, STRATEGIES, PRESET_LABEL,
  banRiskScore, banRiskLabel, banRiskCls,
  AB_DEFAULTS, type AntiBanValues, type RandomnessLevel,
} from '@/lib/warmup-ui'
import { AntiBanConfig } from '@/components/warmup/AntiBanConfig'
import type { HealthResult }   from '@/lib/services/warming/health-calculator.service'
import type { ScheduleResult } from '@/lib/services/warming/daily-quota-calculator.service'
import type { HealthHistoryPoint, HistorySummary } from '@/lib/services/warming/warming-orchestrator.service'

// ── Types ──────────────────────────────────────────────────────────────────────

interface DayStat  { day: number; sent: number; failed: number; skipped: number }
interface ActivityLog {
  id: string; recipient: string; message_type: string
  message_preview: string; status: string; warmup_day: number; sent_at: string
}
interface LineDetail {
  id: string; phone_number: string; instance_name: string; display_name: string | null
  warmup_status: 'active' | 'paused' | 'completed' | 'banned'
  current_day: number; target_days: number
  messages_sent_today: number; daily_limit: number
  last_message_at: string | null; start_date: string | null
  notes: string | null; delay_preset: DelayPreset; timezone: string
  // Phase 4: anti-ban fields
  delay_min_seconds:    number | null
  delay_max_seconds:    number | null
  sending_window_start: string | null
  sending_window_end:   string | null
  active_days:          number[] | null
  anti_ban_enabled:     boolean | null
  randomness_level:     RandomnessLevel | null
  natural_distribution: boolean | null
}
interface DetailData {
  line:         LineDetail
  daily_stats:  DayStat[]
  recent_logs:  ActivityLog[]
  success_rate: number | null
  total_sent:   number
  total_logs:   number
}

type Tab = 'overview' | 'config' | 'activity' | 'alerts'
type LogFilter = 'all' | 'sent' | 'failed'

interface LineAlert {
  id:           string
  severity:     string
  type:         string
  message:      string
  triggered_at: string
  resolved_at:  string | null
}

// ── Props ──────────────────────────────────────────────────────────────────────
interface Props {
  lineId:      string | null
  defaultTab?: Tab
  onClose:     () => void
  onRefresh:   () => void
  /** Resultado del endpoint GET /api/warmup/[id]/health — opcional, calculado en tiempo real. */
  healthData?: { health: HealthResult; schedule: ScheduleResult }
}

// ── Bar chart ──────────────────────────────────────────────────────────────────
const BAR_H = 64

function DayChart({ line, stats }: { line: LineDetail; stats: DayStat[] }) {
  const [hoveredDay, setHoveredDay] = useState<number | null>(null)
  const statsMap = new Map(stats.map(s => [s.day, s]))
  const days = Array.from({ length: Math.max(line.current_day, 1) }, (_, i) => i + 1)

  const hovStat = hoveredDay !== null ? (statsMap.get(hoveredDay) ?? null) : null
  const hovLim  = hoveredDay !== null ? getDailyLimitForDay(hoveredDay, line.target_days) : null

  return (
    <div>
      <div className="flex items-center justify-between mb-2 min-h-[22px]">
        <p className="text-xs font-medium text-gray-600">Mensajes por día vs. límite</p>
        {hoveredDay !== null && hovLim !== null ? (
          <span className="text-[10px] bg-gray-800 text-white rounded px-2 py-0.5 font-mono">
            Día {hoveredDay}: {hovStat?.sent ?? 0}/{hovLim}
            {(hovStat?.failed ?? 0) > 0 ? ` · ${hovStat!.failed} fall.` : ''}
          </span>
        ) : (
          <span className="text-[10px] text-gray-400 italic">Pasa el cursor sobre una barra</span>
        )}
      </div>
      <div className="flex items-end gap-px overflow-x-auto pb-3">
        {days.map(day => {
          const lim       = getDailyLimitForDay(day, line.target_days)
          const stat      = statsMap.get(day)
          const pct       = stat ? Math.min((stat.sent / Math.max(lim, 1)) * 100, 100) : 0
          const hasFail   = (stat?.failed ?? 0) > 0
          const isCurrent = day === line.current_day
          const isHovered = day === hoveredDay

          return (
            <div key={day}
              className="flex flex-col items-center gap-0.5 shrink-0 cursor-default"
              style={{ width: 16 }}
              onMouseEnter={() => setHoveredDay(day)}
              onMouseLeave={() => setHoveredDay(null)}
            >
              <div
                className={`relative w-full rounded-t-sm ${isCurrent ? 'ring-1 ring-amber-400 ring-offset-0' : ''}`}
                style={{ height: BAR_H, background: isHovered ? '#e5e7eb' : '#f3f4f6', transition: 'background 0.1s' }}
              >
                <div className="absolute top-0 left-0 right-0 z-10 border-t border-dashed border-gray-400/50 pointer-events-none" />
                <div className="absolute bottom-0 left-0 right-0 rounded-t-sm transition-all"
                  style={{ height: `${pct}%`, background: isHovered ? '#f59e0b' : '#fbbf24' }} />
                {hasFail && <div className="absolute top-0 left-0 right-0 z-20 h-1.5 bg-red-400 rounded-t-sm" />}
              </div>
              {(day === 1 || day % 7 === 0 || day === line.current_day)
                ? <span className="text-[9px] text-gray-400 leading-none">{day}</span>
                : <span className="text-[9px] text-gray-200 leading-none">·</span>
              }
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-4 text-[10px] text-gray-400 mt-1">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-400 inline-block" /> Enviados</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-400 inline-block" /> Fallidos</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm ring-1 ring-amber-400 inline-block" /> Día actual</span>
        <span className="flex items-center gap-1"><span className="inline-block w-4 border-t border-dashed border-gray-400/60" /> Límite</span>
      </div>
    </div>
  )
}

// ── Health history chart ───────────────────────────────────────────────────────
function HealthHistoryChart({ history, summary }: { history: HealthHistoryPoint[]; summary: HistorySummary }) {
  const CHART_H = 48

  const trendColor = summary.trend.direction === 'improving'
    ? 'text-green-600' : summary.trend.direction === 'declining'
    ? 'text-red-500'   : 'text-gray-500'

  const trendLabel = summary.trend.direction === 'improving' ? '↑ Mejorando'
    : summary.trend.direction === 'declining' ? '↓ Declinando' : '→ Estable'

  const maxScore = Math.max(...history.map(h => h.score), 1)

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium text-gray-600">Historial de salud (14 días)</p>
        <div className="flex items-center gap-3 text-[10px]">
          <span className="text-gray-400">Prom: <strong className="text-gray-600">{summary.averageScore}</strong></span>
          <span className={`font-semibold ${trendColor}`}>{trendLabel}</span>
        </div>
      </div>
      <div className="flex items-end gap-1">
        {[...history].reverse().map((h, i) => {
          const pct  = Math.round((h.score / maxScore) * 100)
          const color = h.score >= 70 ? '#22c55e' : h.score >= 40 ? '#f59e0b' : '#ef4444'
          const date  = new Date(h.recordedAt).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-0.5 cursor-default group relative"
              title={`${date}: ${h.score}/100 · cuota ${h.dailyQuota}`}
            >
              <div className="w-full rounded-t-sm bg-gray-100"
                style={{ height: CHART_H, position: 'relative' }}>
                <div className="absolute bottom-0 left-0 right-0 rounded-t-sm transition-all"
                  style={{ height: `${pct}%`, background: color }} />
              </div>
              <span className="text-[8px] text-gray-300 group-hover:text-gray-500">{date.slice(0, 5)}</span>
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-4 text-[10px] text-gray-400 mt-1.5">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-green-400 inline-block" /> ≥70</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-400 inline-block" /> 40–69</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-400 inline-block" /> &lt;40</span>
        <span className="ml-auto">Min {summary.minScore} · Max {summary.maxScore}</span>
      </div>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function toTimeInput(t: string | null, fallback: string): string {
  return t ? String(t).slice(0, 5) : fallback
}

function lineToAb(l: LineDetail): AntiBanValues {
  return {
    enabled:     l.anti_ban_enabled ?? false,
    delayMin:    l.delay_min_seconds ?? AB_DEFAULTS.delayMin,
    delayMax:    l.delay_max_seconds ?? AB_DEFAULTS.delayMax,
    windowStart: toTimeInput(l.sending_window_start, AB_DEFAULTS.windowStart),
    windowEnd:   toTimeInput(l.sending_window_end,   AB_DEFAULTS.windowEnd),
    activeDays:  l.active_days       ?? AB_DEFAULTS.activeDays,
    randomness:  l.randomness_level  ?? AB_DEFAULTS.randomness,
    naturalDist: l.natural_distribution ?? AB_DEFAULTS.naturalDist,
  }
}

// ── Main component ─────────────────────────────────────────────────────────────
export function WarmupLineDetail({ lineId, defaultTab = 'overview', onClose, onRefresh, healthData }: Props) {
  const [tab, setTab]   = useState<Tab>(defaultTab)
  const [data, setData] = useState<DetailData | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetchErr, setFetchErr] = useState<string | null>(null)

  // Config form — warmup params
  const [cfgName,   setCfgName]   = useState('')
  const [cfgNotes,  setCfgNotes]  = useState('')
  const [cfgPreset, setCfgPreset] = useState<DelayPreset>('normal')
  const [cfgLimit,  setCfgLimit]  = useState('')
  const [cfgDays,   setCfgDays]   = useState('')
  const [saving,    setSaving]    = useState(false)
  const [saveErr,   setSaveErr]   = useState('')
  const [saveOk,    setSaveOk]    = useState(false)

  // Phase 4: anti-ban config (single state object)
  const [abConfig, setAbConfig] = useState<AntiBanValues>(AB_DEFAULTS)

  // Reset confirm
  const [resetConfirm, setResetConfirm] = useState(false)
  const [resetting,    setResetting]    = useState(false)

  // Toggle status
  const [toggling, setToggling] = useState(false)

  // Activity filter + pagination
  const [logFilter,   setLogFilter]   = useState<LogFilter>('all')
  const [allLogs,     setAllLogs]     = useState<ActivityLog[]>([])
  const [totalLogs,   setTotalLogs]   = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)

  // Timestamp
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null)

  // Fase 2: historial de salud
  const [historyData,    setHistoryData]    = useState<{ history: HealthHistoryPoint[]; summary: HistorySummary } | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)

  // Fase 3: alertas de la línea
  const [lineAlerts,       setLineAlerts]       = useState<LineAlert[]>([])
  const [alertsLoading,    setAlertsLoading]    = useState(false)
  const [resolvingAlertId, setResolvingAlertId] = useState<string | null>(null)
  const [showResolved,     setShowResolved]     = useState(false)

  const fillForm = (d: DetailData) => {
    setCfgName(d.line.display_name || '')
    setCfgNotes(d.line.notes || '')
    setCfgPreset(d.line.delay_preset || 'normal')
    setCfgLimit(String(d.line.daily_limit))
    setCfgDays(String(d.line.target_days))
    setAbConfig(lineToAb(d.line))
  }

  const fetchDetail = useCallback(async (id: string) => {
    setLoading(true); setFetchErr(null)
    try {
      const res = await fetch(`/api/warmup/${id}/detail`)
      const d   = await res.json()
      if (d.error) throw new Error(d.error)
      setData(d)
      setLastFetchedAt(new Date())
      setAllLogs(d.recent_logs)
      setTotalLogs(d.total_logs ?? 0)
      fillForm(d)
    } catch (e) {
      setFetchErr(e instanceof Error ? e.message : 'Error al cargar')
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchHistory = useCallback(async (id: string) => {
    setHistoryLoading(true)
    try {
      const res  = await fetch(`/api/warmup/history?lineId=${id}&days=14`)
      const json = await res.json()
      if (json.history) setHistoryData({ history: json.history, summary: json.summary })
      else setHistoryData(null)
    } catch {
      setHistoryData(null)
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const fetchAlerts = useCallback(async (id: string, resolved = false) => {
    setAlertsLoading(true)
    try {
      const res  = await fetch(`/api/warmup/alerts?lineId=${id}&resolved=${resolved}`)
      const json = await res.json()
      setLineAlerts(json.alerts ?? [])
    } catch {
      setLineAlerts([])
    } finally {
      setAlertsLoading(false)
    }
  }, [])

  const resolveAlert = async (alertId: string, lineId: string) => {
    setResolvingAlertId(alertId)
    try {
      await fetch(`/api/warmup/alerts/${alertId}/resolve`, { method: 'POST' })
      await fetchAlerts(lineId, showResolved)
    } finally {
      setResolvingAlertId(null)
    }
  }

  useEffect(() => {
    if (!lineId) {
      setData(null); setAllLogs([]); setTotalLogs(0)
      setLastFetchedAt(null); setHistoryData(null); setLineAlerts([])
      return
    }
    setTab(defaultTab)
    fetchDetail(lineId)
    fetchHistory(lineId)
    fetchAlerts(lineId, false)
  }, [lineId, defaultTab, fetchDetail, fetchHistory, fetchAlerts])

  const saveConfig = async () => {
    if (!data) return
    setSaving(true); setSaveErr(''); setSaveOk(false)
    const res = await fetch(`/api/warmup/${data.line.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name:         cfgName.trim() || null,
        notes:                cfgNotes.trim() || null,
        delay_preset:         cfgPreset,
        daily_limit:          Number(cfgLimit) || data.line.daily_limit,
        target_days:          Number(cfgDays)  || data.line.target_days,
        // Phase 4 anti-ban fields
        anti_ban_enabled:     abConfig.enabled,
        delay_min_seconds:    abConfig.delayMin,
        delay_max_seconds:    abConfig.delayMax,
        sending_window_start: abConfig.windowStart,
        sending_window_end:   abConfig.windowEnd,
        active_days:          abConfig.activeDays,
        randomness_level:     abConfig.randomness,
        natural_distribution: abConfig.naturalDist,
      }),
    })
    setSaving(false)
    if (!res.ok) { const d = await res.json(); setSaveErr(d.error || 'Error al guardar'); return }
    setSaveOk(true)
    setTimeout(() => setSaveOk(false), 2000)
    onRefresh()
    fetchDetail(data.line.id)
  }

  const toggleStatus = async () => {
    if (!data) return
    setToggling(true)
    const next = data.line.warmup_status === 'active' ? 'paused' : 'active'
    await fetch(`/api/warmup/${data.line.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ warmup_status: next }),
    })
    setToggling(false)
    onRefresh()
    fetchDetail(data.line.id)
  }

  const resetLine = async () => {
    if (!data) return
    setResetting(true)
    await fetch(`/api/warmup/${data.line.id}/reset`, { method: 'POST' })
    setResetting(false)
    setResetConfirm(false)
    onRefresh()
    fetchDetail(data.line.id)
  }

  const loadMore = async () => {
    if (!data || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await fetch(`/api/warmup/${data.line.id}/detail?logs_offset=${allLogs.length}`)
      const d   = await res.json()
      if (!d.error) setAllLogs(prev => [...prev, ...d.recent_logs])
    } finally {
      setLoadingMore(false)
    }
  }

  // ── Derived ──────────────────────────────────────────────────────────────────
  const line      = data?.line
  const score     = line ? healthScore(line) : 0
  const riskScore = line ? banRiskScore(line) : 0
  const riskCls   = banRiskCls(riskScore)
  const cfg       = line ? (STATUS_CFG[line.warmup_status] ?? STATUS_CFG.active) : STATUS_CFG.active
  const dayPct    = line ? Math.min((line.current_day / Math.max(line.target_days, 1)) * 100, 100) : 0
  const isActive  = line?.warmup_status === 'active'
  const canToggle = line?.warmup_status === 'active' || line?.warmup_status === 'paused'

  // Alerts
  const alerts: { icon: React.ReactNode; msg: string; cls: string }[] = []
  if (line) {
    if (score < 40 && line.warmup_status !== 'banned')
      alerts.push({ icon: <AlertTriangle size={13} />, msg: 'Salud crítica — considerá pausar la línea', cls: 'text-red-600 bg-red-50 border-red-200' })
    if (line.warmup_status === 'active' && line.last_message_at) {
      const daysSince = (Date.now() - new Date(line.last_message_at).getTime()) / 86_400_000
      if (daysSince >= 3)
        alerts.push({ icon: <Clock size={13} />, msg: `Sin actividad hace ${Math.floor(daysSince)} días — verificá la instancia en Evolution`, cls: 'text-amber-700 bg-amber-50 border-amber-200' })
    }
    if (data && data.total_sent > 0) {
      const failRate = data.daily_stats.reduce((s, d) => s + d.failed, 0) / (data.total_sent + data.daily_stats.reduce((s, d) => s + d.failed, 0))
      if (failRate > 0.3)
        alerts.push({ icon: <AlertTriangle size={13} />, msg: `Tasa de error alta (${Math.round(failRate * 100)}%) — revisá la conectividad`, cls: 'text-orange-700 bg-orange-50 border-orange-200' })
    }
    // Phase 4: high risk + no anti-ban enabled
    if (riskScore >= 70 && !line.anti_ban_enabled)
      alerts.push({ icon: <ShieldAlert size={13} />, msg: 'Riesgo de ban alto — activá el Modo Anti-Ban en Configuración', cls: 'text-red-700 bg-red-50 border-red-200' })
  }

  const filteredLogs = allLogs.filter(l =>
    logFilter === 'all' ? true : l.status === logFilter
  )

  // ── Tab bar ───────────────────────────────────────────────────────────────────
  const activeAlertCount = lineAlerts.filter(a => !a.resolved_at).length
  const tabs: { key: Tab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { key: 'overview',  label: 'Resumen',       icon: <Activity   size={13} /> },
    { key: 'config',    label: 'Configuración', icon: <Settings   size={13} /> },
    { key: 'activity',  label: 'Actividad',     icon: <TrendingUp size={13} /> },
    { key: 'alerts',    label: 'Alertas',       icon: <Bell       size={13} />, badge: activeAlertCount },
  ]

  return (
    <Dialog open={!!lineId} onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden">

        {/* ── Header ── */}
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-gray-100 shrink-0">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle className="flex items-center gap-2 text-base min-w-0">
              <Flame size={16} className="text-orange-500 shrink-0" />
              <span className="truncate">{line ? (line.display_name || line.instance_name) : '…'}</span>
              {line && (
                <div className="flex items-center gap-1 ml-1 shrink-0">
                  <div className={`w-1.5 h-1.5 rounded-full ${cfg.dotCls}`} />
                  <Badge className={`text-[11px] px-1.5 py-0 ${cfg.cls}`}>{cfg.label}</Badge>
                </div>
              )}
              {/* Phase 4: protection mode badge */}
              {line?.anti_ban_enabled && (
                <span className="shrink-0 flex items-center gap-1 text-[10px] text-blue-700 bg-blue-50 border border-blue-200 rounded-full px-2 py-0.5">
                  <Shield size={9} /> Protección activa
                </span>
              )}
            </DialogTitle>
            <div className="flex items-center gap-3 shrink-0">
              {line && (
                <span className="text-[11px] text-gray-400 font-mono">{fmtPhone(line.phone_number)}</span>
              )}
              {lastFetchedAt && (
                <span className="text-[10px] text-gray-300 flex items-center gap-1">
                  <RefreshCw size={9} />
                  {lastFetchedAt.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex gap-1 mt-3">
            {tabs.map(t => (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  tab === t.key
                    ? 'bg-gray-100 text-gray-800'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                }`}
              >
                {t.icon} {t.label}
                {t.key === 'activity' && totalLogs > 0 && (
                  <span className="ml-0.5 bg-gray-200 text-gray-600 rounded-full px-1.5 py-px text-[10px]">
                    {totalLogs}
                  </span>
                )}
                {t.key === 'alerts' && (t.badge ?? 0) > 0 && (
                  <span className="ml-0.5 bg-red-100 text-red-600 rounded-full px-1.5 py-px text-[10px] font-semibold">
                    {t.badge}
                  </span>
                )}
              </button>
            ))}
          </div>
        </DialogHeader>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto">

          {loading && (
            <div className="flex flex-col items-center gap-3 py-16">
              <Loader2 size={28} className="animate-spin text-gray-300" />
              <p className="text-sm text-gray-400">Cargando detalle…</p>
            </div>
          )}
          {!loading && fetchErr && (
            <div className="p-6">
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{fetchErr}</p>
            </div>
          )}

          {/* ── OVERVIEW ─────────────────────────────────────────────────── */}
          {!loading && !fetchErr && data && tab === 'overview' && (() => {
            const l = data.line
            return <div className="p-5 space-y-5">

              {/* Alerts */}
              {alerts.length > 0 && (
                <div className="space-y-2">
                  {alerts.map((a, i) => (
                    <div key={i} className={`flex items-start gap-2 text-xs border rounded-lg px-3 py-2 ${a.cls}`}>
                      <span className="shrink-0 mt-0.5">{a.icon}</span>
                      <span>{a.msg}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Stats grid */}
              <div className="grid grid-cols-4 gap-3">
                {/* Health */}
                <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                  <p className="text-[10px] text-gray-400 mb-1">Salud</p>
                  <div className="flex items-end gap-1.5">
                    <span className="text-2xl font-bold text-gray-800">{score}</span>
                    <span className="text-xs text-gray-400 mb-0.5">/100</span>
                  </div>
                  <div className="mt-1.5 w-full bg-gray-200 rounded-full h-1">
                    <div className={`h-1 rounded-full ${healthColor(score)}`} style={{ width: `${score}%` }} />
                  </div>
                  <p className="text-[10px] text-gray-500 mt-1">{healthLabel(score)}</p>
                </div>

                {/* Progress */}
                <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                  <p className="text-[10px] text-gray-400 mb-1">Progreso</p>
                  <div className="flex items-end gap-1.5">
                    <span className="text-2xl font-bold text-gray-800">{Math.round(dayPct)}</span>
                    <span className="text-xs text-gray-400 mb-0.5">%</span>
                  </div>
                  <div className="mt-1.5 w-full bg-gray-200 rounded-full h-1">
                    <div className="h-1 rounded-full bg-amber-400" style={{ width: `${dayPct}%` }} />
                  </div>
                  <p className="text-[10px] text-gray-500 mt-1">Día {l.current_day} de {l.target_days}</p>
                </div>

                {/* Success rate */}
                <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                  <p className="text-[10px] text-gray-400 mb-1">Tasa de éxito</p>
                  <div className="flex items-end gap-1.5">
                    <span className="text-2xl font-bold text-gray-800">
                      {data.success_rate !== null ? data.success_rate : '—'}
                    </span>
                    {data.success_rate !== null && <span className="text-xs text-gray-400 mb-0.5">%</span>}
                  </div>
                  <p className="text-[10px] text-gray-500 mt-2">{data.total_sent} enviados total</p>
                </div>

                {/* Phase 4: Ban risk card */}
                <div className={`rounded-xl border p-3 ${riskCls.border} ${riskCls.bg}`}>
                  <p className="text-[10px] text-gray-400 mb-1">Riesgo de ban</p>
                  <div className="flex items-end gap-1.5">
                    <span className={`text-2xl font-bold ${riskCls.text}`}>{riskScore}</span>
                    <span className="text-xs text-gray-400 mb-0.5">/100</span>
                  </div>
                  <div className="mt-1.5 w-full bg-white/60 rounded-full h-1">
                    <div className={`h-1 rounded-full ${riskCls.dot}`} style={{ width: `${riskScore}%` }} />
                  </div>
                  <p className={`text-[10px] mt-1 font-medium ${riskCls.text}`}>{banRiskLabel(riskScore)}</p>
                </div>
              </div>

              {/* Anti-ban status pill */}
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1.5 text-[10px] font-medium px-2 py-1 rounded-full border ${
                  l.anti_ban_enabled
                    ? 'bg-blue-50 text-blue-700 border-blue-200'
                    : 'bg-gray-50 text-gray-500 border-gray-200'
                }`}>
                  {l.anti_ban_enabled ? <Shield size={10} /> : <ShieldAlert size={10} />}
                  {l.anti_ban_enabled ? 'Anti-ban activo' : 'Anti-ban inactivo'}
                </span>
                {!l.anti_ban_enabled && (
                  <span className="text-[10px] text-gray-400 italic">
                    Activá la protección en Configuración para reducir el riesgo de ban
                  </span>
                )}
              </div>

              {/* Phase 4: Anti-ban detail card — only when enabled */}
              {l.anti_ban_enabled && (
                <div className="rounded-xl border border-blue-100 bg-blue-50/40 p-3.5">
                  <p className="text-[10px] font-semibold text-blue-600 uppercase tracking-wide mb-3 flex items-center gap-1.5">
                    <Shield size={10} /> Protección Anti-Ban activa
                  </p>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <p className="text-[10px] text-blue-500 mb-0.5">Delay entre mensajes</p>
                      <p className="text-sm font-bold text-blue-800">
                        {l.delay_min_seconds ?? 45}–{l.delay_max_seconds ?? 180}s
                      </p>
                      <p className="text-[10px] text-blue-400">
                        ≈ {Math.round(((l.delay_min_seconds ?? 45) + (l.delay_max_seconds ?? 180)) / 2)}s promedio
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-blue-500 mb-0.5">Ventana de envío</p>
                      <p className="text-sm font-bold text-blue-800">
                        {toTimeInput(l.sending_window_start, '09:00')} → {toTimeInput(l.sending_window_end, '22:00')}
                      </p>
                      <p className="text-[10px] text-blue-400">
                        {(() => {
                          const [sh, sm] = toTimeInput(l.sending_window_start, '09:00').split(':').map(Number)
                          const [eh, em] = toTimeInput(l.sending_window_end, '22:00').split(':').map(Number)
                          return `${Math.max(0, (eh * 60 + em - sh * 60 - sm) / 60).toFixed(1)}h activas`
                        })()}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-blue-500 mb-0.5">Días activos</p>
                      <p className="text-sm font-bold text-blue-800">
                        {(l.active_days ?? [1,2,3,4,5,6,7]).length}/7 días
                      </p>
                      <p className="text-[10px] text-blue-400 leading-tight">
                        {(l.active_days ?? []).length === 7
                          ? 'Todos los días'
                          : (l.active_days ?? []).map(d => ['','L','M','X','J','V','S','D'][d]).join(' ')}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Desglose de salud (Fase 1.5) ── */}
              {healthData && (() => {
                const { health, schedule } = healthData
                const c = health.components
                return (
                  <div className="rounded-xl border border-gray-100 bg-gray-50/60 p-3.5 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                        Desglose de salud
                      </p>
                      <div className="flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${health.color}`} />
                        <span className="text-[11px] font-semibold text-gray-700">{health.score}/100 — {health.label}</span>
                      </div>
                    </div>

                    {/* Contribuciones positivas */}
                    <div className="grid grid-cols-3 gap-2">
                      {([
                        { label: 'Base',       value: c.base,          max: 30, positive: true  },
                        { label: 'Progreso',   value: c.progressScore, max: 30, positive: true  },
                        { label: 'Tendencia',  value: c.trendScore,    max: 20, positive: true  },
                        { label: 'Actividad',  value: c.activityScore, max: 20, positive: true  },
                        { label: 'Inactividad',value: c.inactivityPenalty, max: 30, positive: false },
                        { label: 'Fallos',     value: c.failurePenalty,    max: 20, positive: false },
                      ] as const).map(row => (
                        <div key={row.label} className="space-y-0.5">
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] text-gray-400">{row.label}</span>
                            <span className={`text-[10px] font-semibold ${row.positive ? 'text-gray-600' : 'text-red-500'}`}>
                              {row.positive ? '+' : '−'}{row.value}
                            </span>
                          </div>
                          <div className="w-full bg-gray-200 rounded-full h-1">
                            <div
                              className={`h-1 rounded-full ${row.positive ? 'bg-amber-400' : 'bg-red-400'}`}
                              style={{ width: `${Math.min((row.value / row.max) * 100, 100)}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Recomendación */}
                    <p className="text-[11px] text-gray-500 italic border-t border-gray-100 pt-2">
                      {health.recommendation}
                    </p>

                    {/* Cuota del día */}
                    <div className="flex items-center gap-3 text-[11px] text-gray-500 border-t border-gray-100 pt-2">
                      <span>Cuota hoy:</span>
                      <span className="font-semibold text-gray-700">{schedule.assignedQuotaToday} msgs</span>
                      <span className="text-gray-400">·</span>
                      <span>{schedule.remainingToday} restantes</span>
                      <span className="text-gray-400">·</span>
                      <span className="text-gray-400">{schedule.phaseLabel}</span>
                    </div>
                  </div>
                )
              })()}

              {/* ── Historial de salud (Fase 2) ── */}
              {historyLoading ? (
                <div className="flex items-center gap-2 text-xs text-gray-400 py-2">
                  <Loader2 size={12} className="animate-spin" /> Cargando historial…
                </div>
              ) : historyData && historyData.history.length > 0 ? (
                <div className="rounded-xl border border-gray-100 bg-gray-50/60 p-3.5">
                  <HealthHistoryChart history={historyData.history} summary={historyData.summary} />
                </div>
              ) : (
                <p className="text-[11px] text-gray-300 italic">
                  Sin historial de salud aún — se registra diariamente al ejecutar el orquestador.
                </p>
              )}

              {/* Last activity */}
              <div className="text-xs text-gray-500 flex items-center gap-1.5">
                <Clock size={11} className="shrink-0" />
                {(() => {
                  const { relative, abs } = timeAgo(l.last_message_at)
                  return l.last_message_at
                    ? <span>Último envío <strong>{relative}</strong> — {abs}</span>
                    : <span className="italic">Sin actividad registrada</span>
                })()}
              </div>

              {/* Day chart */}
              {data.daily_stats.length > 0 || l.current_day > 0 ? (
                <DayChart line={l} stats={data.daily_stats} />
              ) : (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <Activity size={24} className="text-gray-200" />
                  <p className="text-sm text-gray-400">Sin datos de actividad aún</p>
                  <p className="text-xs text-gray-300">Los gráficos aparecerán cuando la línea comience el calentamiento</p>
                </div>
              )}

              {/* Last fetch timestamp */}
              {lastFetchedAt && (
                <p className="text-[10px] text-gray-300 flex items-center gap-1 pt-1">
                  <RefreshCw size={9} />
                  Última verificación: {lastFetchedAt.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </p>
              )}
            </div>
          })()}

          {/* ── CONFIG ──────────────────────────────────────────────────── */}
          {!loading && !fetchErr && data && tab === 'config' && (
            <div className="p-5 space-y-5">

              <p className="text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
                Los cambios se aplican en el próximo ciclo de calentamiento.
              </p>

              {/* Name + Notes */}
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Nombre de la línea</label>
                  <Input value={cfgName} onChange={e => setCfgName(e.target.value)}
                    placeholder={data.line.instance_name} className="text-sm" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Notas internas</label>
                  <textarea value={cfgNotes} onChange={e => setCfgNotes(e.target.value)}
                    placeholder="Observaciones, propósito, etc." rows={2}
                    className="w-full text-sm border border-input rounded-md px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-0 placeholder:text-muted-foreground" />
                </div>
              </div>

              {/* Warmup speed strategy */}
              <div>
                <label className="text-xs text-gray-500 mb-1.5 block flex items-center gap-1">
                  <TrendingUp size={11} /> Velocidad de calentamiento
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {STRATEGIES.map(s => (
                    <button key={s.key} type="button"
                      onClick={() => { setCfgPreset(s.key); setCfgDays(String(s.targetDays)); setCfgLimit(String(s.dailyLimit)) }}
                      className={`rounded-lg border-2 px-3 py-2 text-left transition-all ${
                        cfgPreset === s.key ? s.cls + ' border-current' : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
                      }`}
                    >
                      <div className="flex items-center gap-1 mb-0.5">
                        {s.key === 'agresiva' && <Zap size={10} />}
                        <span className="font-semibold text-xs">{s.label}</span>
                      </div>
                      <p className="text-[10px] opacity-80">{s.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Limits */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Días objetivo</label>
                  <Input type="number" min={1} max={60} value={cfgDays} onChange={e => setCfgDays(e.target.value)} />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Límite diario</label>
                  <Input type="number" min={1} max={100} value={cfgLimit} onChange={e => setCfgLimit(e.target.value)} />
                </div>
              </div>

              {/* Phase 4: Anti-ban configuration section */}
              <AntiBanConfig value={abConfig} onChange={setAbConfig} />

              {/* Phase 5: Simulation panel — shown only when anti-ban is enabled */}
              {abConfig.enabled && (() => {
                const tz       = data.line.timezone ?? 'America/Argentina/Buenos_Aires'
                const simNow   = new Date()
                const inDay    = isActiveDay(abConfig.activeDays, tz, simNow)
                const inWin    = isActiveWindow(abConfig.windowStart, abConfig.windowEnd, tz, simNow)
                const elapsed  = data.line.last_message_at
                  ? simNow.getTime() - new Date(data.line.last_message_at).getTime()
                  : Infinity
                const cooldownMs   = Math.max(0, abConfig.delayMin * 1000 - elapsed)
                const cooldownSecs = Math.round(cooldownMs / 1000)
                const avgDelay     = Math.round((abConfig.delayMin + abConfig.delayMax) / 2)
                const allClear     = inDay && inWin && cooldownMs === 0

                return (
                  <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-4">
                    <p className="text-[10px] font-semibold text-indigo-600 uppercase tracking-wide mb-3 flex items-center gap-1.5">
                      <Zap size={10} /> Simulación del próximo envío
                    </p>
                    <div className="space-y-2">
                      <div className="flex items-start gap-2.5">
                        <div className={`w-1.5 h-1.5 rounded-full mt-1 shrink-0 ${inDay ? 'bg-green-400' : 'bg-red-400'}`} />
                        <span className="text-xs text-gray-700">
                          {inDay
                            ? 'Hoy es un día activo — envíos habilitados'
                            : 'Hoy no es un día activo — sin envíos hasta el próximo día configurado'}
                        </span>
                      </div>
                      <div className="flex items-start gap-2.5">
                        <div className={`w-1.5 h-1.5 rounded-full mt-1 shrink-0 ${inWin ? 'bg-green-400' : 'bg-amber-400'}`} />
                        <span className="text-xs text-gray-700">
                          {inWin
                            ? `Dentro de ventana horaria (${abConfig.windowStart} – ${abConfig.windowEnd})`
                            : `Fuera de ventana — próximo envío posible a partir de las ${abConfig.windowStart}`}
                        </span>
                      </div>
                      <div className="flex items-start gap-2.5">
                        <div className={`w-1.5 h-1.5 rounded-full mt-1 shrink-0 ${cooldownMs === 0 ? 'bg-green-400' : 'bg-amber-400'}`} />
                        <span className="text-xs text-gray-700">
                          {cooldownMs === 0
                            ? 'Cooldown completado — listo para enviar'
                            : `Cooldown: faltan ~${cooldownSecs}s (mínimo configurado: ${abConfig.delayMin}s)`}
                        </span>
                      </div>
                    </div>
                    <div className="mt-3 pt-2.5 border-t border-indigo-100 flex items-center justify-between">
                      <span className="text-[10px] text-indigo-500">Delay estimado para el próximo envío</span>
                      <span className="text-[10px] font-mono font-semibold text-indigo-700">
                        {abConfig.delayMin}–{abConfig.delayMax}s{' '}
                        <span className="font-normal opacity-70">(≈ {avgDelay}s promedio)</span>
                      </span>
                    </div>
                    {allClear && (
                      <p className="mt-2 text-[10px] text-green-600 font-medium flex items-center gap-1">
                        <CheckCircle2 size={9} /> El motor enviará en el próximo ciclo de 15 min
                      </p>
                    )}
                  </div>
                )
              })()}

              {saveErr && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-1.5">{saveErr}</p>}

              <Button className="w-full bg-orange-500 hover:bg-orange-600" onClick={saveConfig} disabled={saving}>
                {saving ? <Loader2 size={14} className="animate-spin mr-2" /> : <Save size={14} className="mr-2" />}
                {saving ? 'Guardando…' : saveOk ? '✓ Guardado' : 'Guardar cambios'}
              </Button>

              {/* Danger zone */}
              <div className="border-t border-gray-100 pt-4 space-y-2">
                <p className="text-[11px] text-gray-400 font-medium uppercase tracking-wide">Acciones</p>
                <div className="flex gap-2">
                  {canToggle && (
                    <Button variant="outline"
                      className={`flex-1 ${isActive ? 'border-amber-300 text-amber-700 hover:bg-amber-50' : 'border-green-300 text-green-700 hover:bg-green-50'}`}
                      onClick={toggleStatus} disabled={toggling}
                    >
                      {toggling
                        ? <Loader2 size={13} className="animate-spin mr-1.5" />
                        : isActive ? <Pause size={13} className="mr-1.5" /> : <Play size={13} className="mr-1.5" />
                      }
                      {isActive ? 'Pausar línea' : 'Reanudar línea'}
                    </Button>
                  )}
                  {!resetConfirm ? (
                    <Button variant="outline"
                      className="flex-1 border-red-200 text-red-600 hover:bg-red-50"
                      onClick={() => setResetConfirm(true)}
                    >
                      <RotateCcw size={13} className="mr-1.5" /> Reiniciar calentamiento
                    </Button>
                  ) : (
                    <div className="flex-1 flex gap-2">
                      <Button variant="outline" className="flex-1 border-gray-200 text-gray-500 text-xs"
                        onClick={() => setResetConfirm(false)}>Cancelar</Button>
                      <Button className="flex-1 bg-red-500 hover:bg-red-600 text-xs" onClick={resetLine} disabled={resetting}>
                        {resetting ? <Loader2 size={12} className="animate-spin mr-1" /> : null}
                        Confirmar reset
                      </Button>
                    </div>
                  )}
                </div>
                <p className="text-[10px] text-gray-400">Reiniciar vuelve la línea al día 1 con estado activo. No borra el historial de actividad.</p>
              </div>
            </div>
          )}

          {/* ── ALERTS ──────────────────────────────────────────────────── */}
          {!loading && !fetchErr && data && tab === 'alerts' && (() => {
            const SEVERITY_CFG: Record<string, { cls: string; dot: string; label: string }> = {
              critical: { cls: 'bg-red-50 border-red-200 text-red-800',         dot: 'bg-red-500',    label: 'Crítica' },
              high:     { cls: 'bg-orange-50 border-orange-200 text-orange-800', dot: 'bg-orange-500', label: 'Alta' },
              medium:   { cls: 'bg-amber-50 border-amber-200 text-amber-800',    dot: 'bg-amber-400',  label: 'Media' },
              low:      { cls: 'bg-gray-50 border-gray-200 text-gray-700',       dot: 'bg-gray-400',   label: 'Baja' },
            }
            const TYPE_LABEL: Record<string, string> = {
              ban_risk:          'Riesgo de ban',
              inactivity:        'Inactividad',
              health_drop:       'Caída de salud',
              high_failure_rate: 'Alta tasa de fallos',
            }
            const visibleAlerts = showResolved ? lineAlerts : lineAlerts.filter(a => !a.resolved_at)
            return (
              <div className="p-5 space-y-4">
                {/* Toggle + refresh */}
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-xs text-gray-500 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={showResolved}
                      onChange={e => {
                        setShowResolved(e.target.checked)
                        fetchAlerts(data.line.id, e.target.checked)
                      }}
                      className="accent-amber-500"
                    />
                    Mostrar resueltas
                  </label>
                  <button
                    className="text-[11px] text-gray-400 hover:text-gray-600 flex items-center gap-1"
                    onClick={() => fetchAlerts(data.line.id, showResolved)}
                  >
                    <RefreshCw size={10} /> Actualizar
                  </button>
                </div>

                {alertsLoading ? (
                  <div className="flex items-center gap-2 py-8 text-gray-400 text-sm justify-center">
                    <Loader2 size={14} className="animate-spin" /> Cargando alertas…
                  </div>
                ) : visibleAlerts.length === 0 ? (
                  <div className="flex flex-col items-center gap-3 py-14 text-center">
                    <CheckCircle2 size={32} className="text-green-300" />
                    <div>
                      <p className="text-sm font-medium text-gray-500">Sin alertas activas</p>
                      <p className="text-xs text-gray-400 mt-1">
                        {showResolved ? 'No hay alertas registradas para esta línea.' : 'Esta línea no tiene alertas pendientes.'}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {visibleAlerts.map(alert => {
                      const cfg = SEVERITY_CFG[alert.severity] ?? SEVERITY_CFG.low
                      const isResolved = !!alert.resolved_at
                      return (
                        <div key={alert.id}
                          className={`flex items-start gap-3 border rounded-lg px-3 py-2.5 ${isResolved ? 'opacity-50 bg-gray-50 border-gray-200' : cfg.cls}`}
                        >
                          <div className={`w-2 h-2 rounded-full shrink-0 mt-1 ${isResolved ? 'bg-gray-400' : cfg.dot}`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap mb-0.5">
                              <span className="text-[11px] font-semibold">{TYPE_LABEL[alert.type] ?? alert.type}</span>
                              <span className={`text-[10px] px-1.5 py-px rounded-full border font-medium ${isResolved ? 'bg-gray-100 border-gray-200 text-gray-500' : cfg.cls}`}>
                                {isResolved ? 'Resuelta' : cfg.label}
                              </span>
                            </div>
                            <p className="text-[12px] leading-snug">{alert.message}</p>
                            <p className="text-[10px] text-gray-400 mt-1">
                              {new Date(alert.triggered_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                              {isResolved && alert.resolved_at && (
                                <> · Resuelta {new Date(alert.resolved_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</>
                              )}
                            </p>
                          </div>
                          {!isResolved && (
                            <button
                              className="shrink-0 text-gray-400 hover:text-gray-600 transition-colors p-0.5"
                              title="Marcar como resuelta"
                              disabled={resolvingAlertId === alert.id}
                              onClick={() => resolveAlert(alert.id, data.line.id)}
                            >
                              {resolvingAlertId === alert.id
                                ? <Loader2 size={13} className="animate-spin" />
                                : <X size={13} />
                              }
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })()}

          {/* ── ACTIVITY ─────────────────────────────────────────────────── */}
          {!loading && !fetchErr && data && tab === 'activity' && (
            <div className="p-5 space-y-3">
              {allLogs.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-14 text-center">
                  <TrendingUp size={28} className="text-gray-200" />
                  <div>
                    <p className="text-sm font-medium text-gray-500">Sin actividad registrada</p>
                    <p className="text-xs text-gray-400 mt-1">Los registros aparecerán cuando la línea comience a enviar mensajes</p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-1.5">
                    {(['all', 'sent', 'failed'] as LogFilter[]).map(f => (
                      <button key={f} onClick={() => setLogFilter(f)}
                        className={`text-xs px-2.5 py-1 rounded-full border font-medium transition-colors ${
                          logFilter === f
                            ? 'bg-gray-800 text-white border-gray-800'
                            : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
                        }`}
                      >
                        {f === 'all' ? 'Todos' : f === 'sent' ? 'Enviados' : 'Fallidos'}
                        {f !== 'all' && (
                          <span className="ml-1 opacity-70">
                            {allLogs.filter(l => l.status === f).length}
                          </span>
                        )}
                      </button>
                    ))}
                    <span className="ml-auto text-[10px] text-gray-400">
                      Mostrando {allLogs.length}{totalLogs > allLogs.length ? ` de ${totalLogs}` : ''} registros
                    </span>
                  </div>

                  {filteredLogs.length === 0 ? (
                    <div className="text-center py-8">
                      <p className="text-sm text-gray-400">
                        Sin registros {logFilter === 'sent' ? 'enviados' : 'fallidos'} en el historial cargado
                      </p>
                    </div>
                  ) : (
                    <div className="border border-gray-100 rounded-lg overflow-hidden">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-gray-100 bg-gray-50">
                            <th className="text-left px-3 py-2 font-medium text-gray-600">Hora</th>
                            <th className="text-left px-3 py-2 font-medium text-gray-600">Destinatario</th>
                            <th className="text-left px-3 py-2 font-medium text-gray-600">Tipo</th>
                            <th className="text-left px-3 py-2 font-medium text-gray-600">Mensaje</th>
                            <th className="text-left px-3 py-2 font-medium text-gray-600">Estado</th>
                            <th className="text-left px-3 py-2 font-medium text-gray-600">Día</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredLogs.map(l => (
                            <tr key={l.id} className="border-b border-gray-50 hover:bg-gray-50">
                              <td className="px-3 py-2 text-gray-400 whitespace-nowrap">
                                {new Date(l.sent_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                              </td>
                              <td className="px-3 py-2 font-mono text-gray-600">{l.recipient}</td>
                              <td className="px-3 py-2 text-gray-500">{l.message_type}</td>
                              <td className="px-3 py-2 text-gray-700 max-w-[200px] truncate">{l.message_preview}</td>
                              <td className="px-3 py-2">
                                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
                                  l.status === 'sent'    ? 'bg-green-100 text-green-700'
                                  : l.status === 'failed' ? 'bg-red-100 text-red-600'
                                  : 'bg-gray-100 text-gray-500'
                                }`}>
                                  {l.status === 'sent'   && <CheckCircle2 size={9} />}
                                  {l.status === 'failed' && <AlertTriangle size={9} />}
                                  {l.status}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-gray-400">{l.warmup_day}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {allLogs.length < totalLogs && (
                    <div className="pt-1 text-center">
                      <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore} className="text-xs">
                        {loadingMore ? <Loader2 size={12} className="animate-spin mr-1.5" /> : null}
                        Cargar más ({totalLogs - allLogs.length} restantes)
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
