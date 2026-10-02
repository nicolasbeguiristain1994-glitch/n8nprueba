'use client'

import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatPesos } from '@/lib/dashboard-format'
import type { DepositAnalytics, DepositBucket } from '@/lib/dashboard-deposits'

const LABELS = { zeus: 'Zeus', bet30: 'Bet30', ganamos: 'Ganamos', argenbet: 'Argenbet' }
const WEEKDAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']
const countLabel = (n: number) => n.toLocaleString('es-AR')

function TemporalChart({ title, rows, label, note }: {
  title: string; rows: DepositBucket[]; label: (key: number) => string; note: string
}) {
  const [metric, setMetric] = useState<'count' | 'amount'>('count')
  // Only the chart's geometric scale uses Number. Money labels retain SQL decimals.
  const chartRows = rows.map(r => ({ ...r, label: label(r.key), value: metric === 'count' ? r.count : Number(r.amount) }))
  return <article className="rounded-xl border bg-card p-4 min-w-0 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold text-sm">{title}</h3>
      <div role="group" aria-label={`Métrica de ${title}`} className="flex rounded-lg bg-muted p-0.5 text-xs">
        <button type="button" aria-pressed={metric === 'count'} onClick={() => setMetric('count')} className={`rounded-md border border-transparent px-3 py-1 ${metric === 'count' ? 'border-border bg-card text-foreground shadow-xs' : ''}`}>Cantidad</button>
        <button type="button" aria-pressed={metric === 'amount'} onClick={() => setMetric('amount')} className={`rounded-md border border-transparent px-3 py-1 ${metric === 'amount' ? 'border-border bg-card text-foreground shadow-xs' : ''}`}>Importe</button>
      </div>
    </div>
    <p className="text-xs text-muted-foreground">{metric === 'count' ? 'Cantidad de depósitos' : 'Importe depositado (ARS)'} · {note}</p>
    <div className="h-56 w-full" role="img" aria-label={`${title}: ${metric === 'count' ? 'cantidad de depósitos' : 'importe en pesos'}. Detalle disponible en la tabla inferior.`}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <BarChart data={chartRows} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
          <YAxis width={64} tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} axisLine={false} allowDecimals={false} tickLine={false} tickFormatter={n => new Intl.NumberFormat('es-AR', { notation: 'compact' }).format(n)} />
          <Tooltip content={({ active, payload }) => {
            const row = payload?.[0]?.payload as (DepositBucket & { label: string }) | undefined
            return active && row ? <div className="rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-md"><strong>{row.label}</strong><p>{countLabel(row.count)} depósitos</p><p>{formatPesos(row.amount)}</p></div> : null
          }} />
          <Bar dataKey="value" fill="var(--chart-1)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
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
  return <section aria-label="Distribución de depósitos sin bonos" className="mb-6 space-y-4">
    <div><h2 className="text-base font-semibold">Distribución de depósitos sin bonos</h2><p className="text-xs text-muted-foreground">{countLabel(data.total.count)} depósitos · {formatPesos(data.total.amount)} · Período, plataforma y agente seleccionados · Horario de Argentina (UTC−3)</p></div>
    <article className="rounded-xl border bg-card p-4 space-y-3">
      <h3 className="font-semibold text-sm">Porcentaje del volumen por plataforma</h3>
      <p className="text-xs text-muted-foreground">Participación sobre el importe total depositado con los filtros activos. Los porcentajes pueden sumar 99,99 % o 100,01 % por redondeo.</p>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{data.platforms.map(p => <div key={p.platform} className="space-y-2">
        <div className="flex justify-between text-sm"><span>{LABELS[p.platform]}</span><strong>{Number(p.percentage).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %</strong></div>
        <div className="h-2 rounded-full bg-muted overflow-hidden"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, Number(p.percentage)))}%` }} /></div>
        <p className="text-xs tabular-nums">{formatPesos(p.amount)} · {countLabel(p.count)} depósitos</p>
      </div>)}</div>
    </article>
    {data.total.count === 0 && <p className="rounded-lg bg-muted p-4 text-sm">No hay depósitos registrados para este período y estos filtros.</p>}
    <div className="grid gap-4 lg:grid-cols-2">
      <TemporalChart title="Depósitos por hora del día" rows={data.hours} label={h => `${String(h).padStart(2, '0')}:00`} note="Acumulados por hora" />
      <TemporalChart title="Cargas por día del mes" rows={data.monthDays} label={d => String(d)} note="Días 1–31; suma los mismos días de los meses del período" />
      <TemporalChart title="Cargas por día de la semana" rows={data.weekdays} label={d => WEEKDAYS[d - 1]} note="Acumulados por día; no es un promedio" />
      <aside className="rounded-xl border bg-card p-5 space-y-3 self-start">
        <h3 className="font-semibold text-sm">Depósitos sin hora registrada</h3>
        <p className="text-xl font-semibold tabular-nums">{countLabel(data.withoutTime.count)} <span className="text-sm font-normal text-muted-foreground">depósitos</span></p>
        <p className="tabular-nums">{formatPesos(data.withoutTime.amount)}</p>
        <p className="text-xs text-muted-foreground">Se incluyen en el volumen total y en los gráficos por día según su fecha registrada. Se excluyen del gráfico horario; no se asignan a las 00:00.</p>
      </aside>
    </div>
  </section>
}
