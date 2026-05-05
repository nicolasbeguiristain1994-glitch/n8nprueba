'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { arrayMove } from '@dnd-kit/sortable'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import type { CrmDashboardData } from '@/app/api/dashboard/crm/route'
import {
  DEFAULT_DATE_RANGE,
  DEFAULT_LAYOUT,
  WIDGET_REGISTRY,
  type DateRange,
  type DashboardLayout,
  type WidgetId,
} from './types'

const AUTO_REFRESH_INTERVAL = 300_000 // 5 minutos

interface UseDashboardReturn {
  layout: DashboardLayout
  data: CrmDashboardData | null
  loading: boolean
  softLoading: boolean
  error: string | null
  lastUpdated: Date | null
  softSuccessCount: number
  visibleWidgets: WidgetId[]
  dateRange: DateRange
  autoRefreshEnabled: boolean
  moveWidget: (from: number, to: number) => void
  toggleWidget: (id: WidgetId) => void
  reorderByIds: (ids: WidgetId[]) => void
  setDateRange: (range: DateRange) => void
  toggleAutoRefresh: () => void
  refresh: () => void
}

export function useDashboard(): UseDashboardReturn {
  const [layout, setLayout] = useLocalStorage<DashboardLayout>('dashboard:layout', DEFAULT_LAYOUT)
  const [dateRange, setDateRangeStored] = useLocalStorage<DateRange>('dashboard:dateRange', DEFAULT_DATE_RANGE)
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useLocalStorage<boolean>('dashboard:autoRefresh', true)

  const [data, setData] = useState<CrmDashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [softLoading, setSoftLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [softSuccessCount, setSoftSuccessCount] = useState(0)

  // Stable refs — interval and visibility handler read these without needing re-creation
  const dateRangeRef = useRef(dateRange)
  const lastUpdatedRef = useRef<Date | null>(null)
  const autoRefreshEnabledRef = useRef(autoRefreshEnabled)

  useEffect(() => { dateRangeRef.current = dateRange },          [dateRange])
  useEffect(() => { lastUpdatedRef.current = lastUpdated },      [lastUpdated])
  useEffect(() => { autoRefreshEnabledRef.current = autoRefreshEnabled }, [autoRefreshEnabled])

  // ── Core fetch ───────────────────────────────────────────────────────────────
  const fetchData = useCallback(async (range: DateRange, soft = false) => {
    if (soft) setSoftLoading(true)
    else setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ from: range.from, to: range.to })
      const res = await fetch(`/api/dashboard/crm?${params}`)
      if (!res.ok) throw new Error('Error al cargar datos del dashboard')
      const json = await res.json() as CrmDashboardData
      setData(json)
      const now = new Date()
      setLastUpdated(now)
      if (soft) setSoftSuccessCount(c => c + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : (soft ? 'Error al refrescar' : 'Error desconocido'))
    } finally {
      if (soft) setSoftLoading(false)
      else setLoading(false)
    }
  }, [])

  // Fetch when dateRange changes (covers initial load too)
  useEffect(() => {
    fetchData(dateRange)
  }, [dateRange, fetchData])

  // Auto-refresh interval — skips fetch when tab is hidden
  useEffect(() => {
    if (!autoRefreshEnabled) return
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      fetchData(dateRangeRef.current, true)
    }, AUTO_REFRESH_INTERVAL)
    return () => clearInterval(id)
  }, [autoRefreshEnabled, fetchData])

  // Visibility API — catch "tab came back to foreground" after being hidden
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

  // ── Layout helpers ───────────────────────────────────────────────────────────
  const safeOrder = useCallback((): WidgetId[] => {
    const known = new Set(WIDGET_REGISTRY.map(w => w.id))
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
      const next = hidden.includes(id) ? hidden.filter(h => h !== id) : [...hidden, id]
      return { ...prev, hidden: next }
    })
  }, [setLayout])

  const setDateRange = useCallback((range: DateRange) => {
    setDateRangeStored(range)
  }, [setDateRangeStored])

  const toggleAutoRefresh = useCallback(() => {
    setAutoRefreshEnabled(prev => !prev)
  }, [setAutoRefreshEnabled])

  const refresh = useCallback(() => {
    fetchData(dateRangeRef.current)
  }, [fetchData])

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
    moveWidget,
    toggleWidget,
    reorderByIds,
    setDateRange,
    toggleAutoRefresh,
    refresh,
  }
}
