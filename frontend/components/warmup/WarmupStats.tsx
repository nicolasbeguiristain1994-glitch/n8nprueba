'use client'
import { Activity, AlertTriangle, Send, CheckCircle, Timer } from 'lucide-react'
import { healthScore } from '@/lib/warmup-ui'
import type { WarmupBase } from '@/lib/warmup-ui'

interface WarmupRow extends WarmupBase {
  messages_sent_today:  number
  total_messages_sent:  number
  target_days:          number
}

interface Props {
  numbers: WarmupRow[]
}

function Stat({
  icon, label, value, sub, highlight,
}: {
  icon:       React.ReactNode
  label:      string
  value:      string | number
  sub?:       string
  highlight?: boolean
}) {
  return (
    <div className="flex items-center gap-2.5">
      <div className={`shrink-0 ${highlight ? 'text-orange-500' : 'text-gray-400'}`}>{icon}</div>
      <div>
        <p className="text-[10px] text-gray-400 leading-tight">{label}</p>
        <p className={`text-sm font-semibold leading-tight ${highlight ? 'text-orange-600' : 'text-gray-700'}`}>{value}</p>
        {sub && <p className="text-[10px] text-gray-400 leading-tight">{sub}</p>}
      </div>
    </div>
  )
}

export function WarmupStats({ numbers }: Props) {
  if (numbers.length === 0) return null

  const scores      = numbers.map(n => healthScore(n))
  const avgHealth   = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
  const atRisk      = numbers.filter((_, i) => scores[i] < 50 && numbers[i].warmup_status !== 'banned').length
  const totalToday  = numbers.reduce((s, n) => s + n.messages_sent_today, 0)
  const totalHist   = numbers.reduce((s, n) => s + n.total_messages_sent, 0)
  const completed   = numbers.filter(n => n.warmup_status === 'completed')
  const avgDays     = completed.length
    ? Math.round(completed.reduce((s, n) => s + n.target_days, 0) / completed.length)
    : null

  const fmtHist = totalHist >= 1000
    ? `${(totalHist / 1000).toFixed(1)}k`
    : String(totalHist)

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 bg-gray-50 border border-gray-100 rounded-lg">
      <Stat
        icon={<Activity size={14} />}
        label="Salud promedio"
        value={`${avgHealth}/100`}
        highlight={avgHealth < 50}
      />
      <div className="w-px h-6 bg-gray-200 shrink-0 hidden sm:block" />
      <Stat
        icon={<AlertTriangle size={14} />}
        label="En riesgo"
        value={atRisk}
        sub={atRisk > 0 ? 'requieren atención' : 'todo OK'}
        highlight={atRisk > 0}
      />
      <div className="w-px h-6 bg-gray-200 shrink-0 hidden sm:block" />
      <Stat
        icon={<Send size={14} />}
        label="Mensajes hoy"
        value={totalToday}
      />
      <div className="w-px h-6 bg-gray-200 shrink-0 hidden sm:block" />
      <Stat
        icon={<CheckCircle size={14} />}
        label="Histórico total"
        value={fmtHist}
        sub="mensajes enviados"
      />
      {avgDays !== null && (
        <>
          <div className="w-px h-6 bg-gray-200 shrink-0 hidden sm:block" />
          <Stat
            icon={<Timer size={14} />}
            label="Promedio completado"
            value={`~${avgDays} días`}
          />
        </>
      )}
    </div>
  )
}
