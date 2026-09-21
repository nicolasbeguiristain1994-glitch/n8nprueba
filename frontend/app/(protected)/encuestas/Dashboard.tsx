'use client'

import * as React from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend, CartesianGrid,
} from 'recharts'
import { Card, CardContent } from '@/components/ui/card'
import { Loader2, TrendingUp, Users, Smile, ThumbsUp } from 'lucide-react'

// ── Colores (consistentes con el form público) ───────────────────────────────
const COLOR_DETRACTOR = '#ef4444'
const COLOR_PASSIVE   = '#eab308'
const COLOR_PROMOTER  = '#10b981'
const COLOR_PRIMARY   = 'oklch(0.62 0.19 259)'   // fallback si no está en tema
const CATEGORICAL     = ['#3b82f6', '#8b5cf6', '#f97316', '#14b8a6', '#f43f5e', '#0ea5e9', '#a855f7', '#f59e0b']

type DistRow = { key: string; count: number }

export interface DashboardData {
  kpis: {
    total_respuestas: number
    nps_score:        number | null
    nps_pct:          { promoters: number; passives: number; detractors: number } | null
    nps_counts:       { promoters: number; passives: number; detractors: number }
    avg_facilidad:    number | null
    avg_cashflow:     number | null
    avg_soporte:      number | null
    avg_nps:          number | null
    avg_satisfaccion: number | null
  }
  distributions: {
    edad:       DistRow[]
    juegos:     DistRow[]
    bonos:      DistRow[]
    motivacion: DistRow[]
    facilidad:  DistRow[]
    cashflow:   DistRow[]
    soporte:    DistRow[]
    nps:        DistRow[]
  }
}

interface Props {
  encuestaId: string
  filters: { from?: string; to?: string; campaign?: string; username?: string }
}

export function Dashboard({ encuestaId, filters }: Props) {
  const [data, setData]       = React.useState<DashboardData | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError]     = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const p = new URLSearchParams()
    if (filters.from)     p.set('from',     new Date(filters.from).toISOString())
    if (filters.to)       p.set('to',       new Date(filters.to).toISOString())
    if (filters.campaign) p.set('campaign', filters.campaign)
    if (filters.username) p.set('username', filters.username)
    fetch(`/api/encuestas/${encuestaId}/dashboard?${p.toString()}`, { cache: 'no-store' })
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Error')
        return r.json()
      })
      .then((d: DashboardData) => { if (!cancelled) { setData(d); setLoading(false) } })
      .catch(e => { if (!cancelled) { setError(String(e.message ?? e)); setLoading(false) } })
    return () => { cancelled = true }
  }, [encuestaId, filters.from, filters.to, filters.campaign, filters.username])

  if (loading) {
    return <div className="py-10 flex justify-center"><Loader2 className="animate-spin" /></div>
  }
  if (error) {
    return <p className="text-sm text-destructive">Error cargando el dashboard: {error}</p>
  }
  if (!data || data.kpis.total_respuestas === 0) {
    return <p className="text-sm text-muted-foreground text-center py-8">No hay datos para los filtros actuales.</p>
  }

  const { kpis, distributions } = data

  return (
    <div className="space-y-4">
      {/* ── KPIs ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Kpi icon={<Users className="size-4" />} label="Respuestas" value={kpis.total_respuestas.toLocaleString('es-AR')} />
        <Kpi
          icon={<TrendingUp className="size-4" />}
          label="NPS score"
          value={kpis.nps_score === null ? '—' : `${kpis.nps_score > 0 ? '+' : ''}${kpis.nps_score}`}
          tone={kpis.nps_score === null ? 'neutral' : kpis.nps_score >= 30 ? 'good' : kpis.nps_score <= 0 ? 'bad' : 'warn'}
        />
        <Kpi
          icon={<ThumbsUp className="size-4" />}
          label="% Promotores"
          value={kpis.nps_pct === null ? '—' : `${kpis.nps_pct.promoters}%`}
          tone="good"
        />
        <Kpi
          icon={<Smile className="size-4" />}
          label="Satisfacción prom."
          value={kpis.avg_satisfaccion === null ? '—' : `${kpis.avg_satisfaccion}/10`}
        />
      </div>

      {/* ── NPS split (donut) + histograma NPS ───────────────────────────── */}
      <div className="grid gap-3 lg:grid-cols-2">
        <ChartCard title="Distribución NPS" subtitle="Detractores / Pasivos / Promotores">
          {kpis.nps_pct ? (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={[
                    { name: 'Detractores', value: kpis.nps_counts.detractors, color: COLOR_DETRACTOR },
                    { name: 'Pasivos',     value: kpis.nps_counts.passives,   color: COLOR_PASSIVE },
                    { name: 'Promotores',  value: kpis.nps_counts.promoters,  color: COLOR_PROMOTER },
                  ]}
                  dataKey="value"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={2}
                >
                  {[COLOR_DETRACTOR, COLOR_PASSIVE, COLOR_PROMOTER].map((c, i) => (
                    <Cell key={i} fill={c} />
                  ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <EmptyChart label="Sin datos de NPS" />
          )}
        </ChartCard>

        <ChartCard title="Histograma NPS (0-10)" subtitle="Cantidad de respuestas por puntaje">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={distributions.nps} margin={{ top: 10, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="key" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {distributions.nps.map((row, i) => {
                  const n = Number(row.key)
                  const c = n <= 6 ? COLOR_DETRACTOR : n <= 8 ? COLOR_PASSIVE : COLOR_PROMOTER
                  return <Cell key={i} fill={c} />
                })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ── Categóricas: edad + juegos + bonos + motivación ────────────── */}
      <div className="grid gap-3 lg:grid-cols-2">
        <ChartCard title="Edad" subtitle="Distribución por rango etario">
          <VerticalBars rows={distributions.edad} />
        </ChartCard>
        <ChartCard title="Juegos favoritos" subtitle="Selecciones (%) — más de una opción por respuesta">
          <HorizontalBars rows={distributions.juegos} total={kpis.total_respuestas} />
        </ChartCard>
        <ChartCard title="Bonos preferidos" subtitle="Selecciones (%)">
          <HorizontalBars rows={distributions.bonos} total={kpis.total_respuestas} />
        </ChartCard>
        <ChartCard title="¿Qué te haría jugar más?" subtitle="Motivación (selecciones, %)">
          <HorizontalBars rows={distributions.motivacion} total={kpis.total_respuestas} />
        </ChartCard>
      </div>

      {/* ── Ratings 1-10: promedios + histograma condensado ─────────────── */}
      <div className="grid gap-3 lg:grid-cols-3">
        <RatingCard title="Facilidad de uso" avg={kpis.avg_facilidad} dist={distributions.facilidad} />
        <RatingCard title="Depósitos / retiros" avg={kpis.avg_cashflow}  dist={distributions.cashflow} />
        <RatingCard title="Atención / soporte" avg={kpis.avg_soporte}   dist={distributions.soporte} />
      </div>
    </div>
  )
}

// ── Helpers UI ───────────────────────────────────────────────────────────────

const tooltipStyle: React.CSSProperties = {
  fontSize: 12,
  backgroundColor: 'hsl(var(--popover, 0 0% 100%))',
  border: '1px solid hsl(var(--border, 220 13% 91%))',
  borderRadius: 8,
}

function Kpi({
  icon, label, value, tone = 'neutral',
}: {
  icon:  React.ReactNode
  label: string
  value: string
  tone?: 'neutral' | 'good' | 'warn' | 'bad'
}) {
  const toneClass =
    tone === 'good' ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'warn' ? 'text-yellow-600 dark:text-yellow-400'
    : tone === 'bad' ? 'text-red-600 dark:text-red-400'
    : 'text-foreground'
  return (
    <Card size="sm">
      <CardContent className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon}
          <span>{label}</span>
        </div>
        <div className={`text-2xl font-heading font-medium tabular-nums ${toneClass}`}>{value}</div>
      </CardContent>
    </Card>
  )
}

function ChartCard({
  title, subtitle, children,
}: {
  title:    string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <Card size="sm">
      <CardContent className="space-y-2">
        <div>
          <p className="text-sm font-medium">{title}</p>
          {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
        </div>
        {children}
      </CardContent>
    </Card>
  )
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="h-[220px] flex items-center justify-center text-xs text-muted-foreground">{label}</div>
  )
}

function VerticalBars({ rows }: { rows: DistRow[] }) {
  if (rows.length === 0) return <EmptyChart label="Sin datos" />
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={rows} margin={{ top: 10, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
        <XAxis dataKey="key" tick={{ fontSize: 11 }} />
        <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
        <Tooltip contentStyle={tooltipStyle} />
        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
          {rows.map((_, i) => <Cell key={i} fill={CATEGORICAL[i % CATEGORICAL.length]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function HorizontalBars({ rows, total }: { rows: DistRow[]; total: number }) {
  if (rows.length === 0) return <EmptyChart label="Sin datos" />
  const withPct = rows.map(r => ({
    ...r,
    pct: total === 0 ? 0 : Math.round((r.count / total) * 100),
  }))
  const height = Math.max(180, withPct.length * 30 + 20)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={withPct} layout="vertical" margin={{ top: 4, right: 20, left: 8, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.2} horizontal={false} />
        <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="key"
          tick={{ fontSize: 11 }}
          width={110}
          interval={0}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(v, _n, entry) => {
            const p = (entry as { payload?: { pct?: number } } | undefined)?.payload?.pct ?? 0
            return [`${v} · ${p}%`, 'Respuestas']
          }}
        />
        <Bar dataKey="count" radius={[0, 4, 4, 0]}>
          {withPct.map((_, i) => <Cell key={i} fill={CATEGORICAL[i % CATEGORICAL.length]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function RatingCard({
  title, avg, dist,
}: {
  title: string
  avg:   number | null
  dist:  DistRow[]
}) {
  return (
    <Card size="sm">
      <CardContent className="space-y-2">
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-medium">{title}</p>
          <span className="text-lg font-heading tabular-nums">{avg === null ? '—' : `${avg}/10`}</span>
        </div>
        <ResponsiveContainer width="100%" height={130}>
          <BarChart data={dist} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
            <XAxis dataKey="key" tick={{ fontSize: 10 }} />
            <YAxis hide />
            <Tooltip contentStyle={tooltipStyle} />
            <Bar dataKey="count" radius={[3, 3, 0, 0]} fill={COLOR_PRIMARY} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}
