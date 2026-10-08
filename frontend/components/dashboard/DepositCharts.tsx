'use client'

import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatPesos } from '@/lib/dashboard-format'
import type { DepositAnalytics, DepositBucket } from '@/lib/dashboard-deposits'
import { Clock3 } from 'lucide-react'

const LABELS = { zeus: 'Zeus', bet30: 'Bet30', ganamos: 'Ganamos', argenbet: 'Argenbet' }
const WEEKDAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']
const countLabel = (n: number) => n.toLocaleString('es-AR')

function TemporalChart({ title, rows, label, note }: {
  title: string; rows: DepositBucket[]; label: (key: number) => string; note: string
}) {
  const [metric, setMetric] = useState<'count' | 'amount'>('count')
  // Only the chart's geometric scale uses Number. Money labels retain SQL decimals.
  const chartRows = rows.map(r => ({ ...r, label: label(r.key), value: metric === 'count' ? r.count : Number(r.amount) }))
  return <article className="surface p-5 min-w-0 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold text-base tracking-tight">{title}</h3>
      <div role="group" aria-label={`Métrica de ${title}`} className="flex rounded-lg bg-muted p-1 text-xs">
        <button type="button" aria-pressed={metric === 'count'} onClick={() => setMetric('count')} className={`rounded-md border border-transparent px-3 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${metric === 'count' ? 'border-border bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}>Cantidad</button>
        <button type="button" aria-pressed={metric === 'amount'} onClick={() => setMetric('amount')} className={`rounded-md border border-transparent px-3 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${metric === 'amount' ? 'border-border bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}>Importe</button>
      </div>
    </div>
    <p className="text-xs text-muted-foreground">{metric === 'count' ? 'Cantidad de depósitos' : 'Importe depositado (ARS)'} · {note}</p>
    <div className="h-64 w-full" role="img" aria-label={`${title}: ${metric === 'count' ? 'cantidad de depósitos' : 'importe en pesos'}. Detalle disponible en la tabla inferior.`}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <BarChart data={chartRows} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
          <YAxis width={64} tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} axisLine={false} allowDecimals={false} tickLine={false} tickFormatter={n => new Intl.NumberFormat('es-AR', { notation: 'compact' }).format(n)} />
          <Tooltip content={({ active, payload }) => {
            const row = payload?.[0]?.payload as (DepositBucket & { label: string }) | undefined
            return active && row ? <div className="rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-md"><strong>{row.label}</strong><p>{countLabel(row.count)} depósitos</p><p>{formatPesos(row.amount)}</p></div> : null
          }} />
          <Bar dataKey="value" fill="var(--chart-1)" radius={[5, 5, 0, 0]} maxBarSize={44} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
    <details className="border-t pt-2">
      <summary className="cursor-pointer text-xs font-medium">Ver cantidades e importes</summary>
      <div className="max-h-64 overflow-auto mt-2"><table className="w-full text-xs tabular-nums">
        <caption className="sr-only">{title}, detalle de cantidades e importes</caption>
        <thead><tr className="text-left"><th scope="col" className="py-2">Período</th><th scope="col" className="text-right">Depósitos</th><th scope="col" className="text-right">Importe (ARS)</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.key} className="border-t"><th scope="row" className="py-1.5 text-left font-normal">{label(r.key)}</th><td className="text-right">{countLabel(r.count)}</td><td className="text-right">{formatPesos(r.amount)}</td></tr>)}</tbody>
      </table></div>
    </details>
  </article>
}

export function DepositCharts({ data, loading }: { data: DepositAnalytics | null; loading: boolean }) {
  if (loading) return <div role="status" className="rounded-xl border p-6 mb-5 text-sm text-muted-foreground">Consultando distribución de depósitos…</div>
  if (!data) return <div role="alert" className="rounded-xl border p-4 mb-5 text-sm text-destructive">No se pudieron consultar los gráficos de depósitos. Usá Reintentar o Refrescar vista.</div>
  const platforms = [...data.platforms].sort((a, b) => Number(b.percentage) - Number(a.percentage))
  const platformCounts = platforms.map(p => ({ ...p, label: LABELS[p.platform] }))
  return <section aria-label="Distribución de depósitos sin bonos" className="mb-6 space-y-5">
    <div className="space-y-1"><h2 className="text-lg font-semibold tracking-tight">Distribución de depósitos sin bonos</h2><p className="text-sm text-muted-foreground">{countLabel(data.total.count)} depósitos · {formatPesos(data.total.amount)}</p><p className="text-xs text-muted-foreground">Período, plataforma y agente seleccionados · Horario de Argentina (UTC−3)</p></div>
    <div className="grid gap-4 lg:grid-cols-2">
      <article className="surface min-w-0 p-5 space-y-5">
        <div className="space-y-1"><h3 className="font-semibold text-base tracking-tight">Participación de depósitos</h3><p className="text-xs text-muted-foreground">Porcentaje del importe por plataforma</p></div>
        <div className="space-y-5">{platforms.map(p => <div key={p.platform} className="space-y-1.5">
          <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_4.5rem] items-center gap-3 text-sm">
            <span className="font-medium">{LABELS[p.platform]}</span>
            <div className="h-2.5 rounded-full bg-muted overflow-hidden"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, Number(p.percentage)))}%` }} /></div>
            <strong className="text-right text-xs tabular-nums">{Number(p.percentage).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %</strong>
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">{formatPesos(p.amount)} · {countLabel(p.count)} depósitos</p>
        </div>)}</div>
        <details className="border-t pt-3 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium hover:text-foreground">Acerca de los porcentajes</summary><p className="pt-2 leading-relaxed">Participación sobre el importe total depositado con los filtros activos. Los porcentajes pueden sumar 99,99 % o 100,01 % por redondeo.</p></details>
      </article>
      <article className="surface min-w-0 p-5 space-y-4">
        <div className="space-y-1"><h3 className="font-semibold text-base tracking-tight">Depósitos por plataforma</h3><p className="text-xs text-muted-foreground">Cantidad de operaciones con los filtros activos</p></div>
        <div className="h-64 w-full" role="img" aria-label="Cantidad de depósitos por plataforma. Los valores exactos se muestran en Participación de depósitos.">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart data={platformCounts} margin={{ top: 24, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} />
              <YAxis width={52} tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} allowDecimals={false} tickFormatter={n => new Intl.NumberFormat('es-AR', { notation: 'compact' }).format(n)} />
              <Tooltip content={({ active, payload }) => {
                const row = payload?.[0]?.payload as (DepositAnalytics['platforms'][number] & { label: string }) | undefined
                return active && row ? <div className="rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-md"><strong>{row.label}</strong><p>{countLabel(row.count)} depósitos</p><p>{formatPesos(row.amount)}</p></div> : null
              }} />
              <Bar dataKey="count" fill="var(--chart-1)" radius={[5, 5, 0, 0]} maxBarSize={64} isAnimationActive={false} label={{ position: 'top', fontSize: 12, fill: 'var(--foreground)', formatter: (value: unknown) => typeof value === 'number' ? countLabel(value) : String(value ?? '') }} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </article>
    </div>
    {data.total.count === 0 && <p className="rounded-lg bg-muted p-4 text-sm">No hay depósitos registrados para este período y estos filtros.</p>}
    <div className="grid gap-4 lg:grid-cols-2">
      <TemporalChart title="Depósitos por hora del día" rows={data.hours} label={h => `${String(h).padStart(2, '0')}:00`} note="Acumulados por hora" />
      <TemporalChart title="Cargas por día del mes" rows={data.monthDays} label={d => String(d)} note="Días 1–31; suma los mismos días de los meses del período" />
      <TemporalChart title="Cargas por día de la semana" rows={data.weekdays} label={d => WEEKDAYS[d - 1]} note="Acumulados por día; no es un promedio" />
      <aside className="surface p-5 space-y-4 self-start">
        <div className="flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary"><Clock3 size={20} aria-hidden="true" /></span><h3 className="font-semibold text-base tracking-tight">Depósitos sin hora registrada</h3></div>
        <p className="text-3xl font-semibold tracking-tight tabular-nums">{countLabel(data.withoutTime.count)} <span className="text-sm font-normal text-muted-foreground">depósitos</span></p>
        <p className="tabular-nums">{formatPesos(data.withoutTime.amount)}</p>
        <p className="text-xs text-muted-foreground">Se incluyen en el volumen total y en los gráficos por día según su fecha registrada. Se excluyen del gráfico horario; no se asignan a las 00:00.</p>
      </aside>
    </div>
  </section>
}
