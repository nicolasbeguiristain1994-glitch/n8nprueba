'use client'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { SlidersHorizontal, CalendarRange, Bell, BellOff } from 'lucide-react'
import { FILTER_DEFS, LEVEL_DEFS, applyFilter, type Conv, type Filter, type CampaignOption, type LevelFilter } from '@/lib/scoring/conversation-scoring'
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
  campaign:       string
  campaigns:      CampaignOption[]
  agent?: string
  agents?: {name:string;count:number}[]
  onAgent?: (value:string)=>void
  level:          LevelFilter
  onCampaign:     (v: string) => void
  onLevel:        (v: LevelFilter) => void
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
  convs, search, filter, campaign, campaigns, level, agent='all', agents=[], onAgent, onCampaign, onLevel, dateFrom, dateTo, followUpOnly, realtimeStatus, notifPermission,
  searchRef, onSearch, onFilter, onDateFrom, onDateTo, onFollowUp, onRequestNotif,
}: Props) {
  const [showAdv, setShowAdv] = useState(false)
  const hasAdv = agent !== 'all' || !!dateFrom || !!dateTo || campaign !== 'all' || level !== 'all' || !['all','unread'].includes(filter)

  return (
    <div className="border-b border-border bg-card p-4 space-y-3 shrink-0">

      {/* Search + realtime dot */}
      <div className="relative">
        <Input
          ref={searchRef}
          placeholder="Buscar nombre, teléfono…"
          value={search}
          onChange={e => onSearch(e.target.value)}
          className="h-10 text-sm pr-12" aria-label="Buscar conversaciones"
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
          <button
            onClick={onRequestNotif}
            title={BELL_TITLE[notifPermission]}
            disabled={notifPermission === 'denied'}
            className="text-muted-foreground hover:text-muted-foreground transition-colors disabled:cursor-not-allowed"
          >
            {notifPermission === 'denied'
              ? <BellOff size={14} className="text-muted-foreground/60" />
              : notifPermission === 'granted'
              ? <Bell size={14} className="text-green-500" />
              : <Bell size={14} className="text-muted-foreground" />
            }
          </button>
          <div
            title={RT_LABEL[realtimeStatus]}
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${RT_DOT[realtimeStatus]}`}
          />
        </div>
      </div>

      <label className="block text-xs font-medium text-muted-foreground">Agente
        <select aria-label="Filtrar por agente" value={agent} onChange={e=>onAgent?.(e.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground">
          <option value="all">Todos los agentes</option><option value="none">Sin agente</option>
          {agents.map(item=><option key={item.name} value={item.name}>{item.name} ({item.count})</option>)}
        </select>
      </label>

      {/* Filter pills + advanced toggle */}
      <div className="flex flex-wrap gap-1 items-center">
        {FILTER_DEFS.filter(item=>showAdv||['all','unread'].includes(item.key)).sort((a,b)=>(a.key==='all'?0:a.key==='unread'?1:2)-(b.key==='all'?0:b.key==='unread'?1:2)).map(({ key, label }) => {
          const count = key === 'all' ? convs.length : applyFilter(convs, key).length
          return (
            <button
              key={key}
              onClick={() => onFilter(key)}
              aria-pressed={filter === key}
              className={`text-xs px-2 py-1 rounded-full border font-medium transition-colors ${
                filter === key
                  ? 'bg-accent text-accent-foreground border-primary/20'
                  : 'bg-card text-muted-foreground border-border hover:border-primary/40'
              }`}
            >
              {label}
              {count > 0 && key !== 'all' && <span title="Entre los hilos cargados" className="ml-1 opacity-70">{count}</span>}
            </button>
          )
        })}
        <button onClick={()=>onFollowUp(!followUpOnly)} aria-pressed={followUpOnly} className={`rounded-md border px-2 py-1 text-xs ${followUpOnly?'border-primary/30 bg-accent text-primary':'border-border text-muted-foreground'}`}>Seguimiento</button>
        <button
          onClick={() => setShowAdv(v => !v)}
          aria-label="Filtros avanzados" aria-expanded={showAdv}
          className={`ml-auto text-xs px-1.5 py-0.5 rounded-full border font-medium transition-colors ${
            showAdv || hasAdv
              ? 'bg-accent text-primary border-primary/30'
              : 'bg-card text-muted-foreground border-border hover:border-primary/40'
          }`}
        >
          <SlidersHorizontal size={12} className="inline mr-0.5" />
          {hasAdv ? 'Filtros activos' : 'Filtros'}
        </button>
      </div>

      {/* Advanced filters */}
      {showAdv && (
        <div className="space-y-1.5 pt-1 border-t border-border">
      <div className="space-y-2">
        <label className="block text-xs font-medium text-muted-foreground">
          Campaña
          <select aria-label="Filtrar por campaña" value={campaign} onChange={e => onCampaign(e.target.value)}
            className="mt-1.5 h-10 w-full min-w-0 rounded-lg border border-input bg-card px-3 text-sm text-foreground">
            <option value="all">Todas las campañas</option>
            <option value="none">Sin campaña</option>
            {campaigns.map(item => <option key={item.id} value={item.id}>{item.name} ({item.count})</option>)}
          </select>
        </label>
        <label className="block text-xs font-medium text-muted-foreground">
          Nivel del contacto
          <select aria-label="Filtrar por nivel" value={level} onChange={e => onLevel(e.target.value as LevelFilter)}
            className="mt-1.5 h-10 w-full min-w-0 rounded-lg border border-input bg-card px-3 text-sm text-foreground">
            <option value="all">Todos los niveles</option>
            {LEVEL_DEFS.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
            <option value="none">Sin nivel</option>
          </select>
        </label>
      </div>

          <div className="flex gap-1 items-center">
            <CalendarRange size={14} className="text-muted-foreground shrink-0" />
            <input
              aria-label="Conversaciones desde" type="date" value={dateFrom} onChange={e => onDateFrom(e.target.value)}
              className="min-w-0 flex-1 h-9 text-xs border border-input bg-card rounded-lg px-2 py-1 focus:outline-none focus:border-ring"
            />
            <span className="text-xs text-muted-foreground">—</span>
            <input
              aria-label="Conversaciones hasta" type="date" value={dateTo} onChange={e => onDateTo(e.target.value)}
              className="min-w-0 flex-1 h-9 text-xs border border-input bg-card rounded-lg px-2 py-1 focus:outline-none focus:border-ring"
            />
            {(dateFrom || dateTo) && (
              <button onClick={() => { onDateFrom(''); onDateTo('') }} aria-label="Limpiar fechas" className="text-xs text-muted-foreground hover:text-muted-foreground">✕</button>
            )}
          </div>

        </div>
      )}
    </div>
  )
}
