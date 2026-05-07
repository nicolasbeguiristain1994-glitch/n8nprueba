'use client'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { SlidersHorizontal, CalendarRange, Calendar, Bell, BellOff } from 'lucide-react'
import { FILTER_DEFS, applyFilter, type Conv, type Filter } from '@/lib/scoring/conversation-scoring'
import type { RealtimeStatus } from '@/hooks/useRealTime'

const RT_DOT: Record<RealtimeStatus, string> = {
  connected:    'bg-green-400',
  connecting:   'bg-amber-400 animate-pulse',
  disconnected: 'bg-gray-300',
}
const RT_LABEL: Record<RealtimeStatus, string> = {
  connected:    'Tiempo real activo',
  connecting:   'Conectando…',
  disconnected: 'Sin conexión en tiempo real',
}

interface Props {
  convs:          Conv[]
  search:         string
  filter:         Filter
  dateFrom:       string
  dateTo:         string
  followUpOnly:   boolean
  realtimeStatus: RealtimeStatus
  notifPermission: NotificationPermission
  searchRef:      React.RefObject<HTMLInputElement | null>
  onSearch:       (v: string)    => void
  onFilter:       (v: Filter)    => void
  onDateFrom:     (v: string)    => void
  onDateTo:       (v: string)    => void
  onFollowUp:     (v: boolean)   => void
  onRequestNotif: ()             => void
}

const BELL_TITLE: Record<NotificationPermission, string> = {
  granted: 'Notificaciones activas',
  denied:  'Notificaciones bloqueadas — habilitá desde la configuración del navegador',
  default: 'Activar notificaciones de escritorio',
}

export function ConversationFilters({
  convs, search, filter, dateFrom, dateTo, followUpOnly, realtimeStatus, notifPermission,
  searchRef, onSearch, onFilter, onDateFrom, onDateTo, onFollowUp, onRequestNotif,
}: Props) {
  const [showAdv, setShowAdv] = useState(false)
  const hasAdv = !!dateFrom || !!dateTo || followUpOnly

  return (
    <div className="border-b border-gray-100 p-2 space-y-2 shrink-0">

      {/* Search + realtime dot */}
      <div className="relative">
        <Input
          ref={searchRef}
          placeholder="Buscar nombre, teléfono…"
          value={search}
          onChange={e => onSearch(e.target.value)}
          className="h-7 text-xs pr-10"
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
          <button
            onClick={onRequestNotif}
            title={BELL_TITLE[notifPermission]}
            disabled={notifPermission === 'denied'}
            className="text-gray-400 hover:text-gray-600 transition-colors disabled:cursor-not-allowed"
          >
            {notifPermission === 'denied'
              ? <BellOff size={11} className="text-gray-300" />
              : notifPermission === 'granted'
              ? <Bell size={11} className="text-green-500" />
              : <Bell size={11} className="text-gray-400" />
            }
          </button>
          <div
            title={RT_LABEL[realtimeStatus]}
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${RT_DOT[realtimeStatus]}`}
          />
        </div>
      </div>

      {/* Filter pills + advanced toggle */}
      <div className="flex flex-wrap gap-1 items-center">
        {FILTER_DEFS.map(({ key, label }) => {
          const count = key === 'all' ? convs.length : applyFilter(convs, key).length
          return (
            <button
              key={key}
              onClick={() => onFilter(key)}
              className={`text-[10px] px-2 py-0.5 rounded-full border font-medium transition-colors ${
                filter === key
                  ? 'bg-green-600 text-white border-green-600'
                  : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
              }`}
            >
              {label}
              {count > 0 && key !== 'all' && <span className="ml-1 opacity-70">{count}</span>}
            </button>
          )
        })}
        <button
          onClick={() => setShowAdv(v => !v)}
          className={`ml-auto text-[10px] px-1.5 py-0.5 rounded-full border font-medium transition-colors ${
            showAdv || hasAdv
              ? 'bg-indigo-50 text-indigo-600 border-indigo-300'
              : 'bg-white text-gray-400 border-gray-200 hover:border-gray-400'
          }`}
        >
          <SlidersHorizontal size={9} className="inline mr-0.5" />
          {hasAdv ? '●' : '…'}
        </button>
      </div>

      {/* Advanced filters */}
      {showAdv && (
        <div className="space-y-1.5 pt-1 border-t border-gray-100">
          <div className="flex gap-1 items-center">
            <CalendarRange size={10} className="text-gray-400 shrink-0" />
            <input
              type="date" value={dateFrom} onChange={e => onDateFrom(e.target.value)}
              className="flex-1 text-[10px] border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:border-indigo-300"
            />
            <span className="text-[10px] text-gray-400">—</span>
            <input
              type="date" value={dateTo} onChange={e => onDateTo(e.target.value)}
              className="flex-1 text-[10px] border border-gray-200 rounded px-1.5 py-0.5 focus:outline-none focus:border-indigo-300"
            />
            {(dateFrom || dateTo) && (
              <button onClick={() => { onDateFrom(''); onDateTo('') }} className="text-[10px] text-gray-400 hover:text-gray-600">✕</button>
            )}
          </div>
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox" checked={followUpOnly} onChange={e => onFollowUp(e.target.checked)}
              className="w-3 h-3 rounded accent-indigo-600"
            />
            <Calendar size={10} className="text-sky-500 shrink-0" />
            <span className="text-[10px] text-gray-600">Solo con seguimiento programado</span>
          </label>
        </div>
      )}
    </div>
  )
}
