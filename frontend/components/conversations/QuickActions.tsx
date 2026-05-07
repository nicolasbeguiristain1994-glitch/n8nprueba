'use client'
import { useState } from 'react'
import { Crown, Clock, UserCheck, Ban, Loader2, Check } from 'lucide-react'
import type { Conv } from '@/lib/scoring/conversation-scoring'

type ActionKey = 'vip' | 'process' | 'schedule' | 'blacklist'

interface Props {
  phone: string
  conv:  Conv | undefined
  onRefresh?: () => void
}

export function QuickActions({ conv, onRefresh }: Props) {
  const [loading, setLoading] = useState<ActionKey | null>(null)
  const [done,    setDone]    = useState<ActionKey | null>(null)

  const flash = (key: ActionKey) => {
    setDone(key)
    setTimeout(() => setDone(null), 2000)
  }

  const run = async (key: ActionKey, fn: () => Promise<void>) => {
    setLoading(key)
    try { await fn() } finally { setLoading(null) }
  }

  const markVip = () => run('vip', async () => {
    if (!conv?.contact_id) return
    const res = await fetch(`/api/contacts/${conv.contact_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segment: 'vip' }),
    })
    if (res.ok) { flash('vip'); onRefresh?.() }
  })

  const markProcess = () => run('process', async () => {
    // Marks locally — backend integration point when conversation_state gets a status field
    await new Promise(r => setTimeout(r, 400))
    flash('process')
  })

  const scheduleFollowUp = () => {
    // Backend integration point: POST /api/conversations/[phone]/follow-up
    flash('schedule')
  }

  const addToBlacklist = () => run('blacklist', async () => {
    if (!confirm('¿Estás seguro de agregar este contacto a la blacklist?')) return
    // Backend integration point: PATCH /api/contacts/[id] with status field
    await new Promise(r => setTimeout(r, 500))
    flash('blacklist')
  })

  const actions: { key: ActionKey; label: string; icon: React.ReactNode; handler: () => void; disabled?: boolean }[] = [
    {
      key: 'vip', label: 'Marcar como VIP',
      icon: <Crown size={13} className="text-yellow-600 shrink-0" />,
      handler: markVip, disabled: !conv?.contact_id,
    },
    {
      key: 'process', label: 'Marcar En Proceso',
      icon: <UserCheck size={13} className="text-blue-600 shrink-0" />,
      handler: markProcess,
    },
    {
      key: 'schedule', label: 'Programar seguimiento',
      icon: <Clock size={13} className="text-indigo-600 shrink-0" />,
      handler: scheduleFollowUp,
    },
    {
      key: 'blacklist', label: 'Agregar a blacklist',
      icon: <Ban size={13} className="text-red-500 shrink-0" />,
      handler: addToBlacklist, disabled: !conv?.contact_id,
    },
  ]

  return (
    <div className="px-3 py-2.5 border-b border-gray-100">
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
        Acciones rápidas
      </p>
      <div className="space-y-1">
        {actions.map(({ key, label, icon, handler, disabled }) => (
          <button
            key={key}
            onClick={handler}
            disabled={loading === key || disabled}
            className="flex items-center gap-2 w-full text-xs px-2.5 py-1.5 rounded border border-gray-100 text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading === key
              ? <Loader2 size={13} className="animate-spin shrink-0" />
              : done === key
              ? <Check size={13} className="text-green-500 shrink-0" />
              : icon
            }
            <span>{label}</span>
            {done === key && <span className="ml-auto text-[10px] text-green-500">✓</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
