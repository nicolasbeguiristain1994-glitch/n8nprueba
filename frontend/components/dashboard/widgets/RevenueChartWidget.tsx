'use client'

import { memo } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis,
  CartesianGrid, Tooltip,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TrendingUp } from 'lucide-react'
import type { RevenueTrendPoint } from '@/app/api/dashboard/crm/route'

interface Props {
  data: RevenueTrendPoint[]
  loading?: boolean
}

function fmtMoney(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`
  return `$${n}`
}

interface TooltipPayloadItem { value?: number }
interface CustomTooltipProps { active?: boolean; payload?: TooltipPayloadItem[]; label?: string }

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border bg-popover p-2.5 text-xs shadow-md">
      <p className="font-medium mb-1">{label}</p>
      <p className="text-violet-500">{fmtMoney(payload[0]?.value ?? 0)}</p>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-48 text-muted-foreground gap-2">
      <TrendingUp className="w-8 h-8 opacity-30" />
      <p className="text-sm">Sin datos de ingresos aún</p>
    </div>
  )
}

export const RevenueChartWidget = memo(function RevenueChartWidget({ data, loading }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-violet-500" />
          Ingresos — últimos 8 meses
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="h-52 rounded-lg bg-muted animate-pulse" />
        ) : data.length === 0 ? (
          <EmptyState />
        ) : (
          <ResponsiveContainer width="100%" height={208}>
            <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="oklch(0.558 0.282 301)" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="oklch(0.558 0.282 301)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 11 }}
                className="fill-muted-foreground"
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={fmtMoney}
                tick={{ fontSize: 11 }}
                className="fill-muted-foreground"
                axisLine={false}
                tickLine={false}
                width={48}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="revenue"
                stroke="oklch(0.558 0.282 301)"
                strokeWidth={2}
                fill="url(#revGrad)"
                dot={{ r: 3, fill: 'oklch(0.558 0.282 301)', strokeWidth: 0 }}
                activeDot={{ r: 5, strokeWidth: 0 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  )
})
