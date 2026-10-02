'use client'

import { memo, useEffect, useState } from 'react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  RefreshCw, SlidersHorizontal, Clock, Database, User, CloudDownload,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DATE_RANGE_LABELS,
  type DateRange,
} from './types'
import { PLATFORMS, type Platform } from '@/lib/casino-agents'
import { describeDateRange } from '@/lib/dashboard-date-range'

import { DashboardDateRangePicker } from './DashboardDateRangePicker'
import { dashboardAgents, agentScopeLabel } from '@/lib/dashboard-scope'

// ── "X min ago" ticker ────────────────────────────────────────────────────────

function useMinutesAgo(date: Date | null): string | null {
  const [label, setLabel] = useState<string | null>(null)

  useEffect(() => {
    if (!date) { setLabel(null); return }

    function compute() {
      const mins = Math.floor((Date.now() - date!.getTime()) / 60000)
      if (mins < 1) return 'ahora mismo'
      if (mins === 1) return 'hace 1 min'
      return `hace ${mins} min`
    }

    setLabel(compute())
    const id = setInterval(() => setLabel(compute()), 60_000)
    return () => clearInterval(id)
  }, [date])

  return label
}

// ── Auto-refresh toggle ───────────────────────────────────────────────────────

interface AutoRefreshToggleProps {
  enabled: boolean
  softLoading: boolean
  onToggle: () => void
}

function AutoRefreshToggle({ enabled, softLoading, onToggle }: AutoRefreshToggleProps) {
  return (
    <button
      onClick={onToggle}
      aria-pressed={enabled}
      aria-label={enabled ? 'Desactivar refresco automático de la vista' : 'Activar refresco automático de la vista'}
      className={cn(
        'flex items-center gap-1.5 h-9 px-2.5 rounded-lg border text-xs font-medium transition-all',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        enabled
          ? 'border-primary/30 bg-primary/8 text-primary'
          : 'border-border text-muted-foreground hover:text-foreground hover:border-border/80',
      )}
    >
      <Clock className={cn('w-3 h-3', softLoading && 'animate-spin')} />
      <span className="hidden sm:inline">Auto</span>
    </button>
  )
}

// ── Platform selector ─────────────────────────────────────────────────────────

const PLATFORM_LABELS: Record<Platform, string> = {
  zeus:        'Zeus',
  bet30:       'Bet30',
  consolidado: 'Consolidado',
  ganamos:     'Ganamos',
  argenbet:    'Argenbet',
}

interface PlatformSelectorProps {
  value: Platform
  onChange: (p: Platform) => void
}

function PlatformSelector({ value, onChange }: PlatformSelectorProps) {
  return (
    <div className="flex items-center gap-1.5">
      <Database className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <Select value={value} onValueChange={v => onChange(v as Platform)}>
        <SelectTrigger aria-label="Plataforma del dashboard" size="sm" className="h-9 w-auto min-w-[80px] text-xs">
          <SelectValue>{PLATFORM_LABELS[value]}</SelectValue>
        </SelectTrigger>
        <SelectContent align="end">
          {PLATFORMS.map(p => (
            <SelectItem key={p} value={p} className="text-xs">
              {PLATFORM_LABELS[p]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

// ── Agent selector ────────────────────────────────────────────────────────────

interface AgentSelectorProps {
  value:    string
  platform: Platform
  onChange: (a: string) => void
}

function AgentSelector({ value, platform, onChange }: AgentSelectorProps) {
  const agents = dashboardAgents(platform)
  return (
    <div className="flex items-center gap-1.5">
      <User className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <Select value={value || '_all'} onValueChange={(v: string | null) => onChange(!v || v === '_all' ? '' : v)}>
        <SelectTrigger aria-label="Agente del dashboard" size="sm" className="h-9 w-auto min-w-[90px] text-xs">
          <SelectValue>{value || 'Todos los agentes'}</SelectValue>
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value="_all" className="text-xs">Todos</SelectItem>
          {agents.map(a => (
            <SelectItem key={a} value={a} className="text-xs capitalize">{a}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

// ── Header ────────────────────────────────────────────────────────────────────

export interface DashboardHeaderProps {
  loading: boolean
  softLoading: boolean
  lastUpdated: Date | null
  dateRange: DateRange
  autoRefreshEnabled: boolean
  platform: Platform
  agent: string
  syncStatus: 'idle' | 'loading'
  onCustomize: () => void
  onRefresh: () => void
  onDateRangeChange: (range: DateRange) => void
  onAutoRefreshToggle: () => void
  onPlatformChange: (p: Platform) => void
  onAgentChange: (a: string) => void
  onSyncCasino: () => void
}

export const DashboardHeader = memo(function DashboardHeader({
  loading,
  softLoading,
  lastUpdated,
  dateRange,
  autoRefreshEnabled,
  platform,
  agent,
  syncStatus,
  onCustomize,
  onRefresh,
  onDateRangeChange,
  onAutoRefreshToggle,
  onPlatformChange,
  onAgentChange,
  onSyncCasino,
}: DashboardHeaderProps) {
  const minutesAgo = useMinutesAgo(lastUpdated)

  return (
    <div className="mb-5 space-y-4">
      <PageHeader title="Dashboard" description="Una mirada a tu operación, tus clientes y tu equipo." className="mb-0"
        actions={<>
          <Button variant="outline" size="sm" onClick={onCustomize} aria-label="Personalizar dashboard"><SlidersHorizontal size={14} /> Personalizar</Button>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading} aria-label="Refrescar vista"><RefreshCw size={14} className={cn((loading || softLoading) && 'animate-spin')} /> Actualizar</Button>
          <Button size="sm" onClick={onSyncCasino} disabled={syncStatus === 'loading'} title={platform === 'consolidado' ? 'Sincronizar Zeus y Bet30' : `Sincronizar casino (${platform})`}><CloudDownload size={14} className={cn(syncStatus === 'loading' && 'animate-pulse')} />{syncStatus === 'loading' ? 'Sincronizando…' : 'Sync casino'}</Button>
        </>} />
      <div className="surface">
        <div className="flex flex-wrap items-center gap-3 p-3">
          <DashboardDateRangePicker value={dateRange} onChange={onDateRangeChange} />
          <div className="hidden h-5 border-l sm:block" aria-hidden="true" />
          <PlatformSelector value={platform} onChange={onPlatformChange} />
          <AgentSelector value={agent} platform={platform} onChange={onAgentChange} />
          <div className="ml-auto flex items-center gap-3">
            {minutesAgo && <span className="hidden text-xs text-muted-foreground xl:inline">Vista consultada {minutesAgo}</span>}
            <AutoRefreshToggle enabled={autoRefreshEnabled} softLoading={softLoading} onToggle={onAutoRefreshToggle} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t bg-muted/25 px-3 py-2 text-[11px] text-muted-foreground" aria-label="Filtros activos del dashboard">
          <span className="font-medium text-foreground">Filtro activo: {PLATFORM_LABELS[platform]} · {agent || 'Todos los agentes'}</span>
          <span>{DATE_RANGE_LABELS[dateRange.preset]} · {describeDateRange(dateRange)} · hora Argentina</span>
          {agent && <button className="text-primary hover:underline" onClick={() => onAgentChange('')}>Ver todos los agentes</button>}
          {agent && platform === 'consolidado' && <span>Equivalencias: {agentScopeLabel(platform, agent)}</span>}
          <span className="ml-auto" title="Estos filtros se guardan en este navegador. Otra computadora puede tener una selección distinta.">Preferencias guardadas en este navegador</span>
        </div>
      </div>
    </div>
  )
})
