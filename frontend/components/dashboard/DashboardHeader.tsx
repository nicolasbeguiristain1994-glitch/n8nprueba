'use client'

import { memo, useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  LayoutDashboard, RefreshCw, SlidersHorizontal, Clock, CalendarRange, Database,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DATE_RANGE_LABELS,
  computeDateRange,
  formatCustomRange,
  type DateRange,
  type DateRangePreset,
} from './types'
import { PLATFORMS, type Platform } from '@/lib/casino-agents'

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

// ── Date range picker ─────────────────────────────────────────────────────────

interface DateRangePickerProps {
  value: DateRange
  onChange: (range: DateRange) => void
}

function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const handlePreset = useCallback((preset: DateRangePreset) => {
    if (preset === 'custom') {
      onChange({ preset: 'custom', from: value.from, to: value.to })
    } else {
      onChange({ preset, ...computeDateRange(preset) })
    }
  }, [onChange, value.from, value.to])

  const handleCustomFrom = useCallback((from: string) => {
    onChange({ ...value, preset: 'custom', from })
  }, [onChange, value])

  const handleCustomTo = useCallback((to: string) => {
    onChange({ ...value, preset: 'custom', to })
  }, [onChange, value])

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <CalendarRange className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <Select value={value.preset} onValueChange={v => handlePreset(v as DateRangePreset)}>
        <SelectTrigger size="sm" className="h-7 w-auto min-w-[130px] text-xs">
          {value.preset === 'custom'
            ? <span className="flex flex-1 text-left truncate">{formatCustomRange(value.from, value.to)}</span>
            : <SelectValue />
          }
        </SelectTrigger>
        <SelectContent align="end">
          {(Object.keys(DATE_RANGE_LABELS) as DateRangePreset[]).map(preset => (
            <SelectItem key={preset} value={preset} className="text-xs">
              {DATE_RANGE_LABELS[preset]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {value.preset === 'custom' && (
        <div className="flex items-center gap-1">
          <Input
            type="date"
            value={value.from}
            max={value.to}
            onChange={e => handleCustomFrom(e.target.value)}
            className="h-7 w-[120px] text-xs px-2"
            aria-label="Desde"
          />
          <span className="text-muted-foreground text-xs">→</span>
          <Input
            type="date"
            value={value.to}
            min={value.from}
            onChange={e => handleCustomTo(e.target.value)}
            className="h-7 w-[120px] text-xs px-2"
            aria-label="Hasta"
          />
        </div>
      )}
    </div>
  )
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
      aria-label={enabled ? 'Desactivar actualización automática' : 'Activar actualización automática'}
      className={cn(
        'flex items-center gap-1.5 h-7 px-2.5 rounded-lg border text-xs font-medium transition-all',
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
        <SelectTrigger size="sm" className="h-7 w-auto min-w-[80px] text-xs">
          <SelectValue />
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

// ── Header ────────────────────────────────────────────────────────────────────

export interface DashboardHeaderProps {
  loading: boolean
  softLoading: boolean
  lastUpdated: Date | null
  dateRange: DateRange
  autoRefreshEnabled: boolean
  platform: Platform
  onCustomize: () => void
  onRefresh: () => void
  onDateRangeChange: (range: DateRange) => void
  onAutoRefreshToggle: () => void
  onPlatformChange: (p: Platform) => void
}

export const DashboardHeader = memo(function DashboardHeader({
  loading,
  softLoading,
  lastUpdated,
  dateRange,
  autoRefreshEnabled,
  platform,
  onCustomize,
  onRefresh,
  onDateRangeChange,
  onAutoRefreshToggle,
  onPlatformChange,
}: DashboardHeaderProps) {
  const minutesAgo = useMinutesAgo(lastUpdated)

  return (
    <div className="mb-6 space-y-3">
      {/* Row 1: title + last-updated */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <LayoutDashboard className="w-5 h-5 text-primary shrink-0" />
          <h1 className="text-xl font-semibold text-foreground leading-tight tracking-tight">Dashboard</h1>
        </div>
        {minutesAgo && (
          <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">
            Actualizado {minutesAgo}
          </span>
        )}
      </div>

      {/* Row 2: controls */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Date range picker */}
        <DateRangePicker value={dateRange} onChange={onDateRangeChange} />

        {/* Platform selector */}
        <PlatformSelector value={platform} onChange={onPlatformChange} />

        <div className="flex items-center gap-1.5 ml-auto">
          {/* Soft-loading indicator */}
          {softLoading && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <RefreshCw className="w-3 h-3 animate-spin" />
              <span className="hidden sm:inline">Actualizando…</span>
            </span>
          )}

          {/* Auto-refresh toggle */}
          <AutoRefreshToggle
            enabled={autoRefreshEnabled}
            softLoading={softLoading}
            onToggle={onAutoRefreshToggle}
          />

          {/* Manual refresh */}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refrescar datos"
          >
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
          </Button>

          {/* Customize */}
          <Button
            variant="outline"
            size="sm"
            onClick={onCustomize}
            className="gap-2"
            aria-label="Personalizar dashboard"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Personalizar</span>
          </Button>
        </div>
      </div>
    </div>
  )
})
