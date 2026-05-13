'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { arrayMove } from '@dnd-kit/sortable'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import type { CasinoSummary, CasinoAgente, CasinoVip, SegCount } from '@/app/api/dashboard/casino/route'
import type { PendingTask, CrmKPIs } from '@/app/api/dashboard/crm/route'
import {
  DEFAULT_DATE_RANGE,
  DEFAULT_LAYOUT,
  WIDGET_REGISTRY,
  type DateRange,
  type DashboardLayout,
  type WidgetId,
} from './types'
import { useDashboardFilters, type DashboardFilters } from './useDashboardFilters'

// ── Combined dashboard data type ─────────────────────────────────────────────

export interface MsgsStats {
  total:     number
  sent:      number
  failed:    number
  delivered: number
  read:      number
  inbound:   number
  last_24h:  number
  read_rate: number
}

export interface DashboardData {
  casino: {
    summary:       CasinoSummary | null
    agentes:       CasinoAgente[]
    vips:          CasinoVip[]
    seg_actividad: SegCount[]
    seg_monto:     SegCount[]
  } | null
  kpis:  CrmKPIs
  tasks: PendingTask[]
  msgs:  MsgsStats | null
}

const FALLBACK_KPIS: CrmKPIs = { contacts: 0, tasks_pending: 0, tasks_overdue: 0 }

const AUTO_REFRESH_INTERVAL = 300_000

interface UseDashboardReturn extends DashboardFilters {
  layout:             DashboardLayout
  data:               DashboardData | null
  loading:            boolean
  softLoading:        boolean
  error:              string | null
  lastUpdated:        Date | null
  softSuccessCount:   number
  visibleWidgets:     WidgetId[]
  dateRange:          DateRange
  autoRefreshEnabled: boolean
  moveWidget:         (from: number, to: number) => void
  toggleWidget:       (id: WidgetId) => void
  reorderByIds:       (ids: WidgetId[]) => void
  setDateRange:       (range: DateRange) => void
  toggleAutoRefresh:  () => void
  refresh:            () => void
}

export function useDashboard(): UseDashboardReturn {
  const [layout, setLayout] = useLocalStorage<DashboardLayout>('dashboard:layout', DEFAULT_LAYOUT)
  const [dateRange, setDateRangeStored] = useLocalStorage<DateRange>('dashboard:dateRange', DEFAULT_DATE_RANGE)
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useLocalStorage<boolean>('dashboard:autoRefresh', true)

  // Platform + agent managed by focused sub-hook
  const { platform, agent, setPlatform, setAgent } = useDashboardFilters()

  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [softLoading, setSoftLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [softSuccessCount, setSoftSuccessCount] = useState(0)

  const dateRangeRef          = useRef(dateRange)
  const lastUpdatedRef        = useRef<Date | null>(null)
  const autoRefreshEnabledRef = useRef(autoRefreshEnabled)
  const platformRef           = useRef(platform)

  useEffect(() => { dateRangeRef.current          = dateRange },           [dateRange])
  useEffect(() => { lastUpdatedRef.current        = lastUpdated },         [lastUpdated])
  useEffect(() => { autoRefreshEnabledRef.current = autoRefreshEnabled },  [autoRefreshEnabled])
  useEffect(() => { platformRef.current           = platform },            [platform])

  // ── Core fetch — casino + crm + msgs in parallel ─────────────────────────────
  const fetchData = useCallback(async (_range: DateRange, soft = false) => {
    if (soft) setSoftLoading(true)
    else setLoading(true)
    setError(null)
    try {
      const [casinoRes, crmRes, msgsRes] = await Promise.all([
        fetch(`/api/dashboard/casino?platform=${platformRef.current}`),
        fetch('/api/dashboard/crm'),
        fetch('/api/dashboard'),
      ])

      const casinoJson = casinoRes.ok ? await casinoRes.json() : null
      const crmJson    = crmRes.ok    ? await crmRes.json()    : null
      const msgsJson   = msgsRes.ok   ? await msgsRes.json()   : null

      setData({
        casino: casinoJson
          ? {
              summary:       casinoJson.summary       ?? null,
              agentes:       casinoJson.agentes        ?? [],
              vips:          casinoJson.vips           ?? [],
              seg_actividad: casinoJson.seg_actividad  ?? [],
              seg_monto:     casinoJson.seg_monto      ?? [],
            }
          : null,
        kpis:  crmJson?.kpis  ?? FALLBACK_KPIS,
        tasks: crmJson?.tasks ?? [],
        msgs:  msgsJson?.stats ?? null,
      })

      setLastUpdated(new Date())
      if (soft) setSoftSuccessCount(c => c + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : (soft ? 'Error al refrescar' : 'Error desconocido'))
    } finally {
      if (soft) setSoftLoading(false)
      else setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData(dateRange) }, [dateRange, platform, fetchData])

  useEffect(() => {
    if (!autoRefreshEnabled) return
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      fetchData(dateRangeRef.current, true)
    }, AUTO_REFRESH_INTERVAL)
    return () => clearInterval(id)
  }, [autoRefreshEnabled, fetchData])

  useEffect(() => {
    function handleVisibilityChange() {
      if (typeof document === 'undefined' || document.hidden) return
      if (!autoRefreshEnabledRef.current) return
      const last = lastUpdatedRef.current
      if (!last || Date.now() - last.getTime() > AUTO_REFRESH_INTERVAL) {
        fetchData(dateRangeRef.current, true)
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [fetchData])

  // ── Layout helpers ────────────────────────────────────────────────────────────
  const safeOrder = useCallback((): WidgetId[] => {
    const known   = new Set(WIDGET_REGISTRY.map(w => w.id))
    const current = (layout.order ?? []).filter(id => known.has(id))
    for (const w of WIDGET_REGISTRY) {
      if (!current.includes(w.id)) current.push(w.id)
    }
    return current
  }, [layout.order])

  const visibleWidgets = safeOrder().filter(id => !(layout.hidden ?? []).includes(id))

  const moveWidget = useCallback((from: number, to: number) => {
    setLayout(prev => ({
      ...prev,
      order: arrayMove(prev.order ?? WIDGET_REGISTRY.map(w => w.id), from, to),
    }))
  }, [setLayout])

  const reorderByIds = useCallback((ids: WidgetId[]) => {
    setLayout(prev => ({ ...prev, order: ids }))
  }, [setLayout])

  const toggleWidget = useCallback((id: WidgetId) => {
    setLayout(prev => {
      const hidden = prev.hidden ?? []
      const next   = hidden.includes(id) ? hidden.filter(h => h !== id) : [...hidden, id]
      return { ...prev, hidden: next }
    })
  }, [setLayout])

  const setDateRange      = useCallback((range: DateRange) => { setDateRangeStored(range) }, [setDateRangeStored])
  const toggleAutoRefresh = useCallback(() => { setAutoRefreshEnabled(prev => !prev) }, [setAutoRefreshEnabled])
  const refresh           = useCallback(() => { fetchData(dateRangeRef.current) }, [fetchData])

  return {
    layout: { ...layout, order: safeOrder() },
    data,
    loading,
    softLoading,
    error,
    lastUpdated,
    softSuccessCount,
    visibleWidgets,
    dateRange,
    autoRefreshEnabled,
    platform,
    agent,
    moveWidget,
    toggleWidget,
    reorderByIds,
    setDateRange,
    toggleAutoRefresh,
    setPlatform,
    setAgent,
    refresh,
  }
}
