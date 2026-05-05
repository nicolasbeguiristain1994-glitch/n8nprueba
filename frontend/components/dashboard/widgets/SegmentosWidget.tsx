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

const ACT_COLORS: Record<string, string> = {
  nuevo:     '#10b981',
  frecuente: '#3b82f6',
  regular:   '#8b5cf6',
  ocasional: '#f59e0b',
  en_riesgo: '#f97316',
  inactivo:  '#ef4444',
  perdido:   '#7f1d1d',
}

const MONTO_COLORS: Record<string, string> = {
  bajo:  '#94a3b8',
  medio: '#60a5fa',
  alto:  '#a78bfa',
  vip:   '#f59e0b',
}

const ACT_LABELS: Record<string, string> = {
  nuevo: 'Nuevo', frecuente: 'Frecuente', regular: 'Regular',
  ocasional: 'Ocasional', en_riesgo: 'En riesgo', inactivo: 'Inactivo', perdido: 'Perdido',
}

const ORDER_ACT  = ['nuevo','frecuente','regular','ocasional','en_riesgo','inactivo','perdido']
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

function MiniBar({ data, colors }: { data: SegCount[]; colors: Record<string, string> }) {
  if (data.length === 0) return <p className="text-xs text-muted-foreground text-center py-4">Sin datos</p>
  return (
    <ResponsiveContainer width="100%" height={90}>
      <BarChart data={data} margin={{ top: 16, right: 4, bottom: 0, left: -20 }}>
        <XAxis dataKey="seg" tick={{ fontSize: 10 }} tickFormatter={v => ACT_LABELS[v] ?? v} />
        <YAxis tick={{ fontSize: 10 }} />
        <Tooltip
          formatter={(v) => [(Number(v) || 0).toLocaleString('es-AR'), 'Jugadores']}
          labelFormatter={l => ACT_LABELS[l as string] ?? l}
          contentStyle={{ fontSize: 11 }}
        />
        <Bar dataKey="cnt" radius={[3, 3, 0, 0]}>
          {data.map(entry => (
            <Cell key={entry.seg} fill={colors[entry.seg] ?? '#94a3b8'} />
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
          <PieChart className="w-4 h-4 text-violet-500" />
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
              <MiniBar data={sortedAct} colors={ACT_COLORS} />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Por nivel de gasto</p>
              <MiniBar data={sortedMonto} colors={MONTO_COLORS} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
})
