'use client'

import { memo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PieChart } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell, LabelList,
} from 'recharts'
import type { SegCount } from '@/app/api/dashboard/casino/route'

interface Props {
  segActividad: SegCount[]
  segMonto:     SegCount[]
  loading?:     boolean
}

/* Colores alineados con la nueva paleta de marca */
const ACT_COLORS: Record<string, string> = {
  nuevo:     '#10b981',
  frecuente: '#4f46e5',  /* primary indigo */
  regular:   '#7c3aed',  /* vip purple */
  ocasional: '#f59e0b',
  en_riesgo: '#f97316',
  inactivo:  '#ef4444',
  perdido:   '#7f1d1d',
}

const MONTO_COLORS: Record<string, string> = {
  bajo:  '#94a3b8',
  medio: '#4f46e5',  /* primary indigo */
  alto:  '#0d9488',  /* accent teal */
  vip:   '#7c3aed',  /* vip purple */
}

const ACT_LABELS: Record<string, string> = {
  nuevo: 'Nuevo', frecuente: 'Frecuente', regular: 'Regular',
  ocasional: 'Ocasional', en_riesgo: 'En riesgo', inactivo: 'Inactivo', perdido: 'Perdido',
}

const ORDER_ACT   = ['nuevo','frecuente','regular','ocasional','en_riesgo','inactivo','perdido']
const ORDER_MONTO = ['bajo','medio','alto','vip']

function sortSeg(data: SegCount[], order: string[]) {
  return [...data].sort((a, b) => order.indexOf(a.seg) - order.indexOf(b.seg))
}

function Skeleton() {
  return (
    <div className="space-y-3">
      <div className="h-4 w-24 bg-muted animate-pulse rounded" />
      <div className="h-28 bg-muted animate-pulse rounded-lg" />
      <div className="h-4 w-24 bg-muted animate-pulse rounded" />
      <div className="h-16 bg-muted animate-pulse rounded-lg" />
    </div>
  )
}

interface TooltipProps { active?: boolean; payload?: Array<{ value?: number }>; label?: string }

function ChartTooltip({ active, payload, label }: TooltipProps) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl border border-border/50 bg-background/80 backdrop-blur-md px-3 py-2 shadow-xl text-xs">
      <p className="font-semibold mb-0.5">{ACT_LABELS[label as string] ?? label}</p>
      <p className="text-muted-foreground">
        {(Number(payload[0]?.value) || 0).toLocaleString('es-AR')} jugadores
      </p>
    </div>
  )
}

function MiniBar({
  data,
  colors,
  gradientPrefix,
}: {
  data: SegCount[]
  colors: Record<string, string>
  gradientPrefix: string
}) {
  if (data.length === 0) return <p className="text-xs text-muted-foreground text-center py-4">Sin datos</p>
  return (
    <ResponsiveContainer width="100%" height={90}>
      <BarChart data={data} margin={{ top: 16, right: 4, bottom: 0, left: -20 }}>
        <defs>
          {data.map(entry => {
            const color = colors[entry.seg] ?? '#94a3b8'
            return (
              <linearGradient
                key={entry.seg}
                id={`${gradientPrefix}-${entry.seg}`}
                x1="0" y1="0" x2="0" y2="1"
              >
                <stop offset="0%"   stopColor={color} stopOpacity={0.92} />
                <stop offset="100%" stopColor={color} stopOpacity={0.55} />
              </linearGradient>
            )
          })}
        </defs>
        <XAxis dataKey="seg" tick={{ fontSize: 10 }} tickFormatter={v => ACT_LABELS[v] ?? v} />
        <YAxis tick={{ fontSize: 10 }} />
        <Tooltip content={<ChartTooltip />} />
        <Bar dataKey="cnt" radius={[6, 6, 0, 0]}>
          {data.map(entry => (
            <Cell key={entry.seg} fill={`url(#${gradientPrefix}-${entry.seg})`} />
          ))}
          <LabelList dataKey="cnt" position="top" style={{ fontSize: 9, fill: '#6b7280' }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

export const SegmentosWidget = memo(function SegmentosWidget({ segActividad, segMonto, loading }: Props) {
  const sortedAct   = sortSeg(segActividad, ORDER_ACT)
  const sortedMonto = sortSeg(segMonto, ORDER_MONTO)

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <PieChart className="w-4 h-4 text-primary" />
          Segmentos de jugadores
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <Skeleton />
        ) : (
          <>
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Por actividad</p>
              <MiniBar data={sortedAct} colors={ACT_COLORS} gradientPrefix="act" />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Por nivel de gasto</p>
              <MiniBar data={sortedMonto} colors={MONTO_COLORS} gradientPrefix="monto" />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
})
