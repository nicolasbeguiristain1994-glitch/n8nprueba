'use client'
import { useState } from 'react'
import { Crown, Clock, UserCheck, CheckCircle2, Ban, ShieldOff, Loader2, Check } from 'lucide-react'
import type { Conv } from '@/lib/scoring/conversation-scoring'

type ActionKey = 'vip' | 'process' | 'resolve' | 'schedule' | 'blacklist' | 'unblacklist'

function ActionButton({
  label, icon, onClick, loading, done, disabled,
}: {
  label: string; icon: React.ReactNode
  onClick: () => void; loading?: boolean; done?: boolean; disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading || disabled}
      className="flex items-center gap-2 w-full text-xs px-2.5 py-1.5 rounded border border-gray-100 text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {loading
        ? <Loader2 size={13} className="animate-spin shrink-0" />
        : done
        ? <Check size={13} className="text-green-500 shrink-0" />
        : icon}
      <span className="truncate">{label}</span>
      {done && <span className="ml-auto text-[10px] text-green-500 shrink-0">✓</span>}
    </button>
  )
}

interface Props { phone: string; conv: Conv | undefined; onRefresh?: () => void }

export function QuickActions({ phone, conv, onRefresh }: Props) {
  const [loading, setLoading] = useState<ActionKey | null>(null)
  const [done,    setDone]    = useState<ActionKey | null>(null)
  const [showFU,  setShowFU]  = useState(false)
  const [fuDate,  setFuDate]  = useState('')
  const [fuNote,  setFuNote]  = useState('')

  const flash = (key: ActionKey) => { setDone(key); setTimeout(() => setDone(null), 2000) }
  const run   = async (key: ActionKey, fn: () => Promise<void>) => {
    setLoading(key); try { await fn() } finally { setLoading(null) }
  }

  const markVip = () => run('vip', async () => {
    if (!conv?.contact_id) return
    const res = await fetch(`/api/contacts/${conv.contact_id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segment: 'super_vip' }),
    })
    if (res.ok) { flash('vip'); onRefresh?.() }
  })

  const markProcess = () => run('process', async () => {
    const res = await fetch(`/api/conversations/${encodeURIComponent(phone)}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow: 'en_proceso' }),
    })
    if (res.ok) { flash('process'); onRefresh?.() }
  })

  const resolveProcess = () => run('resolve', async () => {
    const res = await fetch(`/api/conversations/${encodeURIComponent(phone)}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow: null }),
    })
    if (res.ok) { flash('resolve'); onRefresh?.() }
  })

  const saveFollowUp = () => run('schedule', async () => {
    if (!fuDate) return
    const label = new Date(fuDate + 'T00:00').toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' })
    const content = `📅 Seguimiento programado: ${label}${fuNote.trim() ? ` — ${fuNote.trim()}` : ''}`
    const res = await fetch(`/api/conversations/${encodeURIComponent(phone)}/notes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    if (res.ok) { flash('schedule'); setShowFU(false); setFuDate(''); setFuNote(''); onRefresh?.() }
  })

  const addToBlacklist = () => {
    if (!confirm('¿Agregar este contacto a la blacklist? No recibirá más mensajes automáticos.')) return
    run('blacklist', async () => {
      const res = await fetch(`/api/conversations/${encodeURIComponent(phone)}/blacklist`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Manual desde CRM' }),
      })
      if (res.ok) { flash('blacklist'); onRefresh?.() }
    })
  }

  const removeFromBlacklist = () => run('unblacklist', async () => {
    const res = await fetch(`/api/conversations/${encodeURIComponent(phone)}/blacklist`, {
      method: 'PATCH',
    })
    if (res.ok) { flash('unblacklist'); onRefresh?.() }
  })

  const inProcess      = conv?.conv_flow === 'en_proceso'
  const isBlacklisted  = conv?.is_blacklisted === true

  return (
    <div className="px-3 py-2.5 border-b border-gray-100">
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
        Acciones rápidas
      </p>
      <div className="space-y-1">

        <ActionButton
          label="Marcar como VIP"
          icon={<Crown size={13} className="text-yellow-600 shrink-0" />}
          onClick={markVip}
          loading={loading === 'vip'} done={done === 'vip'}
          disabled={!conv?.contact_id}
        />

        {inProcess ? (
          <ActionButton
            label="Resolver (quitar En Proceso)"
            icon={<CheckCircle2 size={13} className="text-gray-500 shrink-0" />}
            onClick={resolveProcess}
            loading={loading === 'resolve'} done={done === 'resolve'}
          />
        ) : (
          <ActionButton
            label="Marcar En Proceso"
            icon={<UserCheck size={13} className="text-blue-600 shrink-0" />}
            onClick={markProcess}
            loading={loading === 'process'} done={done === 'process'}
          />
        )}

        <ActionButton
          label="Programar seguimiento"
          icon={<Clock size={13} className="text-indigo-600 shrink-0" />}
          onClick={() => setShowFU(v => !v)}
          loading={loading === 'schedule'} done={done === 'schedule'}
        />

        {showFU && (
          <div className="p-2 bg-indigo-50 border border-indigo-100 rounded space-y-1.5">
            <input
              type="date"
              value={fuDate}
              onChange={e => setFuDate(e.target.value)}
              className="w-full text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-indigo-300"
            />
            <input
              type="text"
              value={fuNote}
              onChange={e => setFuNote(e.target.value)}
              placeholder="Nota (opcional)"
              className="w-full text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-indigo-300 placeholder:text-gray-300"
            />
            <button
              onClick={saveFollowUp}
              disabled={!fuDate || loading === 'schedule'}
              className="w-full text-xs bg-indigo-600 text-white rounded py-1 hover:bg-indigo-700 disabled:opacity-40 transition-colors"
            >
              Guardar seguimiento
            </button>
          </div>
        )}

        {isBlacklisted ? (
          <ActionButton
            label="Remover de blacklist"
            icon={<ShieldOff size={13} className="text-gray-500 shrink-0" />}
            onClick={removeFromBlacklist}
            loading={loading === 'unblacklist'} done={done === 'unblacklist'}
          />
        ) : (
          <ActionButton
            label="Agregar a blacklist"
            icon={<Ban size={13} className="text-red-500 shrink-0" />}
            onClick={addToBlacklist}
            loading={loading === 'blacklist'} done={done === 'blacklist'}
          />
        )}

      </div>
    </div>
  )
}
