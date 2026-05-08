'use client'

/**
 * WarmupIntelligence
 *
 * Sección colapsable "Inteligencia" del dashboard de calentamiento.
 * Incluye tres sub-secciones con navegación por tabs:
 *   Alertas     — Centro de alertas predictivas activas
 *   Efectividad — Métricas de éxito del pool de calentamiento
 *   Simulador   — What-if: proyecciones y simulaciones de escenarios
 */

import { useState, useCallback, useEffect } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Brain, ChevronDown, ChevronUp, AlertTriangle, ShieldAlert,
  Activity, BarChart2, Play, Loader2, CheckCircle, RefreshCw,
  Zap, TrendingUp, Clock, X,
} from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'
import type { EffectivenessReport } from '@/lib/services/warming/warming-effectiveness.service'
import type { SimulationResult } from '@/lib/services/warming/warming-simulator.service'

// ── Tipos ──────────────────────────────────────────────────────────────────────

type IntelTab = 'alerts' | 'effectiveness' | 'simulator'

interface AlertRow {
  id:              string
  warmup_number_id: string
  severity:        string
  type:            string
  message:         string
  data:            Record<string, unknown>
  triggered_at:    string
  resolved_at:     string | null
  phone_number:    string
  instance_name:   string
  display_name:    string | null
}

interface Props {
  /** Cantidad de alertas activas para mostrar en el badge del header (se actualiza al abrir). */
  onOpenLine?: (lineId: string) => void
}

// ── Helpers de UI ─────────────────────────────────────────────────────────────

const SEVERITY_CFG: Record<string, { cls: string; dot: string; label: string }> = {
  critical: { cls: 'bg-red-50 border-red-200 text-red-800',    dot: 'bg-red-500',    label: 'Crítica' },
  high:     { cls: 'bg-orange-50 border-orange-200 text-orange-800', dot: 'bg-orange-500', label: 'Alta' },
  medium:   { cls: 'bg-amber-50 border-amber-200 text-amber-800',    dot: 'bg-amber-400',  label: 'Media' },
  low:      { cls: 'bg-gray-50 border-gray-200 text-gray-700',  dot: 'bg-gray-400',   label: 'Baja' },
}

const ALERT_TYPE_LABEL: Record<string, string> = {
  ban_risk:          'Riesgo de ban',
  inactivity:        'Inactividad',
  health_drop:       'Caída de salud',
  high_failure_rate: 'Fallos elevados',
}

function SeverityBadge({ severity }: { severity: string }) {
  const cfg = SEVERITY_CFG[severity] ?? SEVERITY_CFG.low
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${cfg.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  )
}

function timeAgoShort(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 60) return `hace ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `hace ${h}h`
  return `hace ${Math.floor(h / 24)}d`
}

// ── Sub-sección: Alertas ──────────────────────────────────────────────────────

function AlertsSection({ onOpenLine }: { onOpenLine?: (id: string) => void }) {
  const [alerts,   setAlerts]   = useState<AlertRow[]>([])
  const [loading,  setLoading]  = useState(false)
  const [total,    setTotal]    = useState(0)
  const [resolving, setResolving] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const data = await fetchJson<{ alerts: AlertRow[]; total: number }>(
      '/api/warmup/alerts',
    ).catch(() => null)
    if (data) { setAlerts(data.alerts); setTotal(data.total) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const resolve = async (id: string) => {
    setResolving(id)
    await fetchJson(`/api/warmup/alerts/${id}/resolve`, { method: 'POST' }).catch(() => null)
    setResolving(null)
    load()
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
        <Loader2 size={14} className="animate-spin" /> Cargando alertas…
      </div>
    )
  }

  if (alerts.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <CheckCircle size={28} className="text-green-400" />
        <p className="text-sm font-medium text-gray-600">Sin alertas activas</p>
        <p className="text-xs text-gray-400">El sistema no detectó riesgos en el último análisis</p>
        <Button size="sm" variant="outline" className="mt-1 text-xs h-7" onClick={load}>
          <RefreshCw size={11} className="mr-1" /> Actualizar
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs text-gray-500">{total} alerta{total !== 1 ? 's' : ''} activa{total !== 1 ? 's' : ''}</p>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-gray-400" onClick={load}>
          <RefreshCw size={10} className="mr-1" /> Actualizar
        </Button>
      </div>
      {alerts.map(a => {
        const cfg  = SEVERITY_CFG[a.severity] ?? SEVERITY_CFG.low
        const name = a.display_name || a.instance_name
        return (
          <div key={a.id} className={`flex items-start gap-3 border rounded-lg px-3 py-2.5 ${cfg.cls}`}>
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <SeverityBadge severity={a.severity} />
                <span className="text-[10px] text-gray-500 font-medium">
                  {ALERT_TYPE_LABEL[a.type] ?? a.type}
                </span>
                <span className="text-[10px] text-gray-400">{timeAgoShort(a.triggered_at)}</span>
              </div>
              <p className="text-xs mt-0.5 leading-snug">{a.message}</p>
              {onOpenLine && (
                <button
                  className="text-[11px] underline opacity-70 hover:opacity-100 mt-0.5"
                  onClick={() => onOpenLine(a.warmup_number_id)}
                >
                  {name}
                </button>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px] shrink-0 opacity-60 hover:opacity-100"
              onClick={() => resolve(a.id)}
              disabled={resolving === a.id}
            >
              {resolving === a.id ? <Loader2 size={10} className="animate-spin" /> : <X size={10} />}
            </Button>
          </div>
        )
      })}
    </div>
  )
}

// ── Sub-sección: Efectividad ──────────────────────────────────────────────────

function EffectivenessSection() {
  const [report,  setReport]  = useState<EffectivenessReport | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const data = await fetchJson<{ report: EffectivenessReport }>(
      '/api/warmup/effectiveness',
    ).catch(() => null)
    if (data) setReport(data.report)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
        <Loader2 size={14} className="animate-spin" /> Calculando métricas…
      </div>
    )
  }

  if (!report || report.totalLines === 0) {
    return <p className="text-sm text-gray-400 py-4">Sin datos de efectividad aún.</p>
  }

  const PRESET_LABEL: Record<string, string> = {
    conservadora: 'Conservadora',
    normal:       'Normal',
    agresiva:     'Agresiva',
  }

  return (
    <div className="space-y-4">
      {/* KPIs principales */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 text-center">
          <p className="text-2xl font-bold text-green-600">{report.overallSuccessRate}%</p>
          <p className="text-[11px] text-gray-500 mt-0.5">Tasa de éxito</p>
          <p className="text-[10px] text-gray-400">vs. estados terminales</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 text-center">
          <p className="text-2xl font-bold text-amber-600">{report.completionRatio}%</p>
          <p className="text-[11px] text-gray-500 mt-0.5">Completadas</p>
          <p className="text-[10px] text-gray-400">{report.completedLines} de {report.totalLines}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 text-center">
          <p className="text-2xl font-bold text-red-500">{report.banRate}%</p>
          <p className="text-[11px] text-gray-500 mt-0.5">Tasa de ban</p>
          <p className="text-[10px] text-gray-400">{report.bannedLines} línea{report.bannedLines !== 1 ? 's' : ''}</p>
        </div>
      </div>

      {/* Top estrategia */}
      {report.topPerformingStrategy && (
        <div className="flex items-center gap-2 text-xs text-gray-600 bg-green-50 border border-green-100 rounded-lg px-3 py-2">
          <TrendingUp size={12} className="text-green-600 shrink-0" />
          <span>Mejor estrategia: <strong>{PRESET_LABEL[report.topPerformingStrategy]}</strong></span>
        </div>
      )}

      {/* Desglose por estrategia */}
      {report.byStrategy.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Por estrategia</p>
          {report.byStrategy.map(s => (
            <div key={s.preset} className="flex items-center gap-3">
              <span className="text-[11px] text-gray-600 w-24 shrink-0">{PRESET_LABEL[s.preset]}</span>
              <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                <div className="h-1.5 rounded-full bg-green-400" style={{ width: `${s.successRate}%` }} />
              </div>
              <span className="text-[11px] text-gray-500 w-10 text-right shrink-0">{s.successRate}%</span>
              <span className="text-[10px] text-gray-400 w-16 text-right shrink-0">
                {s.completedLines}/{s.totalLines} líneas
              </span>
              <span className="text-[10px] text-gray-400 w-14 text-right shrink-0">
                {s.avgHealthScore} salud
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Sub-sección: Simulador ────────────────────────────────────────────────────

type Scenario = 'add_lines' | 'change_strategy' | 'project_health'

function SimulatorSection() {
  const [scenario,   setScenario]   = useState<Scenario>('project_health')
  const [loading,    setLoading]    = useState(false)
  const [result,     setResult]     = useState<SimulationResult | null>(null)

  // add_lines
  const [newCount,    setNewCount]    = useState('3')
  const [newStrategy, setNewStrategy] = useState('normal')
  const [newDays,     setNewDays]     = useState('21')

  // change_strategy
  const [targetStrategy, setTargetStrategy] = useState('normal')

  // project_health
  const [projDays, setProjDays] = useState('14')

  const run = async () => {
    setLoading(true)
    setResult(null)
    const body: Record<string, unknown> = { scenario }

    if (scenario === 'add_lines') {
      body.newLinesCount      = parseInt(newCount, 10)
      body.newLinesStrategy   = newStrategy
      body.newLinesTargetDays = parseInt(newDays, 10)
    } else if (scenario === 'change_strategy') {
      body.targetStrategy = targetStrategy
    } else {
      body.projectionDays = parseInt(projDays, 10)
    }

    const data = await fetchJson<SimulationResult>('/api/warmup/simulator', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }).catch(() => null)

    setResult(data)
    setLoading(false)
  }

  const SCENARIOS: { key: Scenario; label: string; icon: React.ReactNode }[] = [
    { key: 'project_health',  label: 'Proyectar salud',      icon: <TrendingUp size={11} /> },
    { key: 'add_lines',       label: 'Agregar líneas',        icon: <Zap size={11} /> },
    { key: 'change_strategy', label: 'Cambiar estrategia',    icon: <Activity size={11} /> },
  ]

  const RISK_CLS: Record<string, string> = {
    low:    'text-green-700 bg-green-50 border-green-200',
    medium: 'text-amber-700 bg-amber-50 border-amber-200',
    high:   'text-red-700 bg-red-50 border-red-200',
  }

  return (
    <div className="space-y-4">
      {/* Selector de escenario */}
      <div className="flex gap-1.5">
        {SCENARIOS.map(s => (
          <button key={s.key} onClick={() => { setScenario(s.key); setResult(null) }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
              scenario === s.key
                ? 'bg-amber-500 text-white border-amber-500'
                : 'bg-white text-gray-600 border-gray-200 hover:border-amber-300'
            }`}
          >
            {s.icon} {s.label}
          </button>
        ))}
      </div>

      {/* Parámetros según escenario */}
      <div className="flex items-center gap-3 flex-wrap">
        {scenario === 'add_lines' && (
          <>
            <div className="flex items-center gap-1.5">
              <label className="text-[11px] text-gray-500">Líneas:</label>
              <input type="number" min={1} max={20} value={newCount}
                onChange={e => setNewCount(e.target.value)}
                className="w-14 text-xs border border-gray-200 rounded px-2 py-1 text-center" />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-[11px] text-gray-500">Estrategia:</label>
              <select value={newStrategy} onChange={e => setNewStrategy(e.target.value)}
                className="text-xs border border-gray-200 rounded px-2 py-1">
                <option value="conservadora">Conservadora</option>
                <option value="normal">Normal</option>
                <option value="agresiva">Agresiva</option>
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-[11px] text-gray-500">Días objetivo:</label>
              <input type="number" min={7} max={60} value={newDays}
                onChange={e => setNewDays(e.target.value)}
                className="w-14 text-xs border border-gray-200 rounded px-2 py-1 text-center" />
            </div>
          </>
        )}

        {scenario === 'change_strategy' && (
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] text-gray-500">Nueva estrategia (todas las activas):</label>
            <select value={targetStrategy} onChange={e => setTargetStrategy(e.target.value)}
              className="text-xs border border-gray-200 rounded px-2 py-1">
              <option value="conservadora">Conservadora (−30% cuota)</option>
              <option value="normal">Normal (cuota base)</option>
              <option value="agresiva">Agresiva (+30% cuota)</option>
            </select>
          </div>
        )}

        {scenario === 'project_health' && (
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] text-gray-500">Proyectar en:</label>
            {[7, 14, 21].map(d => (
              <button key={d}
                onClick={() => setProjDays(String(d))}
                className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                  projDays === String(d)
                    ? 'bg-gray-800 text-white border-gray-800'
                    : 'border-gray-200 text-gray-600 hover:border-gray-400'
                }`}
              >
                {d} días
              </button>
            ))}
          </div>
        )}

        <Button size="sm" className="bg-amber-500 hover:bg-amber-600 h-7 px-3 text-xs"
          onClick={run} disabled={loading}>
          {loading ? <Loader2 size={12} className="animate-spin mr-1" /> : <Play size={11} className="mr-1" />}
          Simular
        </Button>
      </div>

      {/* Resultados */}
      {result && (
        <div className="space-y-3 border-t border-gray-100 pt-3">
          <p className="text-xs text-gray-500 italic">{result.inputSummary}</p>

          {/* Totales */}
          <div className="grid grid-cols-4 gap-2">
            <div className="bg-gray-50 rounded-lg p-2.5 text-center">
              <p className="text-sm font-bold text-gray-700">{result.totals.currentQuota}</p>
              <p className="text-[10px] text-gray-400">Cuota actual</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-2.5 text-center">
              <p className="text-sm font-bold text-amber-600">{result.totals.projectedQuota}</p>
              <p className="text-[10px] text-gray-400">Cuota proyectada</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-2.5 text-center">
              <p className={`text-sm font-bold ${result.totals.quotaChange >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                {result.totals.quotaChange >= 0 ? '+' : ''}{result.totals.quotaChange}
              </p>
              <p className="text-[10px] text-gray-400">Cambio</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-2.5 text-center">
              <p className="text-sm font-bold text-blue-600">{result.insights.avgProjectedHealth}</p>
              <p className="text-[10px] text-gray-400">Salud prom.</p>
            </div>
          </div>

          {/* Nivel de riesgo */}
          <div className={`flex items-start gap-2 text-xs border rounded-lg px-3 py-2 ${RISK_CLS[result.insights.riskLevel]}`}>
            <ShieldAlert size={13} className="shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold capitalize">Riesgo {result.insights.riskLevel}: </span>
              {result.insights.riskDetails}
            </div>
          </div>

          <p className="text-[11px] text-gray-600 bg-amber-50 border border-amber-100 rounded px-2.5 py-1.5">
            {result.insights.recommendation}
          </p>

          {/* Tabla de proyecciones (máx 8 filas) */}
          {result.projections.length > 0 && (
            <div className="border border-gray-100 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Línea</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Salud</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Cuota</th>
                    <th className="text-left px-2 py-2 font-medium text-gray-600">Nota</th>
                  </tr>
                </thead>
                <tbody>
                  {result.projections.slice(0, 8).map((p, i) => (
                    <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-3 py-1.5 text-gray-700 truncate max-w-[120px]">
                        {p.lineId.startsWith('nueva') ? <span className="text-amber-600">{p.lineId}</span> : p.lineId.slice(0, 8) + '…'}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <span className={p.projectedHealthScore >= 70 ? 'text-green-600' : p.projectedHealthScore >= 40 ? 'text-amber-600' : 'text-red-500'}>
                          {p.currentHealthScore > 0 ? `${p.currentHealthScore}→` : ''}{p.projectedHealthScore}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-600">
                        {p.currentDailyQuota > 0 ? `${p.currentDailyQuota}→` : ''}{p.projectedDailyQuota}
                      </td>
                      <td className="px-2 py-1.5 text-gray-400 text-[10px] truncate max-w-[140px]">{p.changeNote}</td>
                    </tr>
                  ))}
                  {result.projections.length > 8 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-1.5 text-center text-[10px] text-gray-400 italic">
                        +{result.projections.length - 8} líneas más…
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Componente principal ──────────────────────────────────────────────────────

export function WarmupIntelligence({ onOpenLine }: Props) {
  const [open,    setOpen]    = useState(false)
  const [tab,     setTab]     = useState<IntelTab>('alerts')
  const [alertCount, setAlertCount] = useState<number | null>(null)

  // Obtener recuento de alertas activas al montar (para el badge del header)
  useEffect(() => {
    fetchJson<{ total: number }>('/api/warmup/alerts')
      .then(d => setAlertCount(d?.total ?? 0))
      .catch(() => {})
  }, [])

  const TABS: { key: IntelTab; label: string; icon: React.ReactNode }[] = [
    { key: 'alerts',        label: 'Alertas',      icon: <AlertTriangle size={12} /> },
    { key: 'effectiveness', label: 'Efectividad',  icon: <BarChart2 size={12} /> },
    { key: 'simulator',     label: 'Simulador',    icon: <Play size={12} /> },
  ]

  return (
    <Card>
      <CardContent className="p-0">
        {/* Header colapsable */}
        <button
          className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
          onClick={() => setOpen(v => !v)}
        >
          <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <Brain size={14} className="text-purple-500" />
            Inteligencia Predictiva
            {alertCount !== null && alertCount > 0 && (
              <span className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                {alertCount}
              </span>
            )}
          </div>
          {open ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
        </button>

        {open && (
          <div className="border-t border-gray-100">
            {/* Tab bar interno */}
            <div className="flex gap-1 px-4 py-2 border-b border-gray-100">
              {TABS.map(t => (
                <button key={t.key} onClick={() => setTab(t.key)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    tab === t.key
                      ? 'bg-gray-100 text-gray-800'
                      : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {t.icon} {t.label}
                  {t.key === 'alerts' && alertCount !== null && alertCount > 0 && (
                    <span className="ml-0.5 bg-red-100 text-red-600 rounded-full px-1.5 py-px text-[10px]">
                      {alertCount}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className="px-4 py-3">
              {tab === 'alerts'        && <AlertsSection onOpenLine={onOpenLine} />}
              {tab === 'effectiveness' && <EffectivenessSection />}
              {tab === 'simulator'     && <SimulatorSection />}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
