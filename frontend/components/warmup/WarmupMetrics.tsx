'use client'
import { useState } from 'react'
import { ChevronDown, ChevronRight, BarChart3 } from 'lucide-react'
import { healthScore, PRESET_LABEL, STRATEGIES } from '@/lib/warmup-ui'
import type { WarmupBase } from '@/lib/warmup-ui'
import type { DelayPreset } from '@/lib/warmup-engine'

interface WarmupRow extends WarmupBase {
  id:                  string
  display_name:        string | null
  instance_name:       string
  delay_preset:        DelayPreset
  total_messages_sent: number
  messages_sent_today: number
}

interface Props { numbers: WarmupRow[] }

// Bar colors per strategy (not derived from STRATEGIES.cls which uses bg-*-50 — too light)
const STRATEGY_BAR: Record<DelayPreset, string> = {
  conservadora: 'bg-blue-400',
  normal:       'bg-amber-400',
  agresiva:     'bg-red-400',
}

export function WarmupMetrics({ numbers }: Props) {
  const [open, setOpen] = useState(false)

  if (numbers.length === 0) return null

  const scores = numbers.map(n => healthScore(n))

  const healthBuckets = [
    { label: 'Óptima',  count: numbers.filter((_, i) => scores[i] >= 80).length,              cls: 'bg-green-400' },
    { label: 'Buena',   count: numbers.filter((_, i) => scores[i] >= 60 && scores[i] < 80).length, cls: 'bg-lime-400' },
    { label: 'Regular', count: numbers.filter((_, i) => scores[i] >= 35 && scores[i] < 60).length, cls: 'bg-amber-400' },
    { label: 'Crítica', count: numbers.filter((_, i) => scores[i] > 0 && scores[i] < 35).length,   cls: 'bg-orange-400' },
    { label: 'Baneada', count: numbers.filter((_, i) => scores[i] === 0).length,               cls: 'bg-red-400' },
  ]

  const strategyCount = { conservadora: 0, normal: 0, agresiva: 0 } as Record<DelayPreset, number>
  for (const n of numbers) {
    if (n.delay_preset in strategyCount) strategyCount[n.delay_preset]++
  }
  const maxStrategy = Math.max(...Object.values(strategyCount), 1)

  const completed = numbers
    .filter(n => n.warmup_status === 'completed')
    .sort((a, b) => a.target_days - b.target_days)
    .slice(0, 5)

  const totalSent  = numbers.reduce((s, n) => s + n.total_messages_sent, 0)
  const totalToday = numbers.reduce((s, n) => s + n.messages_sent_today, 0)
  const avgScore   = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0

  return (
    <div className="border border-gray-100 rounded-lg overflow-hidden bg-white">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <BarChart3 size={13} className="text-gray-400" />
          Métricas avanzadas
        </span>
        {open
          ? <ChevronDown size={13} className="text-gray-400" />
          : <ChevronRight size={13} className="text-gray-400" />}
      </button>

      {open && (
        <div className="grid grid-cols-3 gap-6 px-4 pb-5 border-t border-gray-100 pt-4">

          {/* ── Health distribution ── */}
          <div>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-3">Distribución de salud</p>
            <div className="space-y-2">
              {healthBuckets.map(b => (
                <div key={b.label} className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-500 w-12 text-right shrink-0">{b.label}</span>
                  <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                    <div
                      className={`h-1.5 rounded-full ${b.cls}`}
                      style={{ width: `${numbers.length ? (b.count / numbers.length) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-gray-400 w-3 shrink-0">{b.count}</span>
                </div>
              ))}
            </div>
          </div>

          {/* ── Strategy distribution + totals ── */}
          <div>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-3">Por estrategia</p>
            <div className="space-y-2 mb-4">
              {(STRATEGIES).map(s => {
                const count = strategyCount[s.key] ?? 0
                return (
                  <div key={s.key} className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-500 w-14 shrink-0">{PRESET_LABEL[s.key]}</span>
                    <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                      <div
                        className={`h-1.5 rounded-full ${STRATEGY_BAR[s.key]}`}
                        style={{ width: `${(count / maxStrategy) * 100}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-gray-400 w-3 shrink-0">{count}</span>
                  </div>
                )
              })}
            </div>
            <div className="space-y-1.5 border-t border-gray-100 pt-3">
              {[
                { label: 'Total enviados',   value: totalSent >= 1000 ? `${(totalSent / 1000).toFixed(1)}k` : String(totalSent) },
                { label: 'Enviados hoy',     value: String(totalToday) },
                { label: 'Salud promedio',   value: `${avgScore}/100` },
              ].map(({ label, value }) => (
                <div key={label} className="flex justify-between">
                  <span className="text-[10px] text-gray-500">{label}</span>
                  <span className="text-[10px] font-semibold text-gray-700">{value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* ── Fastest completions ── */}
          <div>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-3">Más rápido completadas</p>
            {completed.length === 0 ? (
              <p className="text-[10px] text-gray-400 italic">Ninguna completada aún</p>
            ) : (
              <div className="space-y-2">
                {completed.map((n, i) => (
                  <div key={n.id} className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-400 w-3 shrink-0">{i + 1}.</span>
                    <span className="text-[10px] text-gray-600 truncate flex-1">{n.display_name || n.instance_name}</span>
                    <span className="text-[10px] font-semibold text-green-600 shrink-0">{n.target_days}d</span>
                  </div>
                ))}
              </div>
            )}
            {completed.length > 0 && (
              <p className="text-[10px] text-gray-400 mt-3 border-t border-gray-100 pt-3">
                {completed.length} línea{completed.length !== 1 ? 's' : ''} finalizada{completed.length !== 1 ? 's' : ''}
              </p>
            )}
          </div>

        </div>
      )}
    </div>
  )
}
