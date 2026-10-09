'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { arrayMove } from '@dnd-kit/sortable'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { takeDashboardPrefetch } from '@/lib/dashboard-prefetch'
import { argentinaToday } from '@/lib/dashboard-format'
import { queryDateRange } from '@/lib/dashboard-date-range'
import type { DepositAnalytics } from '@/lib/dashboard-deposits'
import type { PlatformActivity } from '@/lib/dashboard-overview'
import type { CasinoSummary, CasinoAgente, CasinoVip, CasinoCashRankingRow, SegCount } from '@/app/api/dashboard/casino/route'
import type { PendingTask, CrmKPIs, CrmDashboardData } from '@/app/api/dashboard/crm/route'
import {
  DEFAULT_DATE_RANGE,
  normalizeDateRange,
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
  deposits: DepositAnalytics | null
  activity: PlatformActivity[] | null
  crmAvailable: boolean
  casino: {
    summary:       CasinoSummary | null
    agentes:       CasinoAgente[]
    vips:          CasinoVip[]
    seg_actividad: SegCount[]
    seg_monto:     SegCount[]
    cash_ranking:  CasinoCashRankingRow[] | null
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
  financeLoading: boolean
  activityLoading: boolean
  depositsLoading: boolean
  loading:            boolean
  softLoading:        boolean
  error:              string | null
  lastUpdated:        Date | null
  revision: number
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

export function useDashboard(userId?: string): UseDashboardReturn {
  const [layout, setLayout] = useLocalStorage<DashboardLayout>('dashboard:layout', DEFAULT_LAYOUT)
  const [savedDateRange, setDateRangeStored] = useLocalStorage<DateRange>('dashboard:dateRange', DEFAULT_DATE_RANGE)
  const today = argentinaToday()
  const normalized = normalizeDateRange(savedDateRange)
  const dateRange = useMemo(() => normalized, [normalized.preset, normalized.from, normalized.to, today])
  useEffect(() => {
    if (JSON.stringify(savedDateRange) !== JSON.stringify(dateRange)) setDateRangeStored(dateRange)
  }, [savedDateRange, dateRange, setDateRangeStored])
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useLocalStorage<boolean>('dashboard:autoRefresh', true)

  // Platform + agent managed by focused sub-hook
  const { platform, agent, setPlatform, setAgent } = useDashboardFilters()

  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [activityLoading, setActivityLoading] = useState(true)
  const [depositsLoading, setDepositsLoading] = useState(true)
  const [softLoading, setSoftLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [revision, setRevision] = useState(0)
  const [softSuccessCount, setSoftSuccessCount] = useState(0)

  const dateRangeRef          = useRef(dateRange)
  const lastUpdatedRef        = useRef<Date | null>(null)
  const autoRefreshEnabledRef = useRef(autoRefreshEnabled)
  const platformRef           = useRef(platform)
  const agentRef = useRef(agent)
  const requestRef = useRef<AbortController | null>(null)
  const initialFetchRef = useRef(true)
  const userIdRef = useRef(userId)
  useEffect(() => { userIdRef.current = userId }, [userId])
  const auxRef = useRef<{ crm: CrmDashboardData; msgs: { stats?: MsgsStats }; at: number } | null>(null)

  useEffect(() => { dateRangeRef.current          = dateRange },           [dateRange])
  useEffect(() => { lastUpdatedRef.current        = lastUpdated },         [lastUpdated])
  useEffect(() => { autoRefreshEnabledRef.current = autoRefreshEnabled },  [autoRefreshEnabled])
  useEffect(() => { platformRef.current           = platform },            [platform])

  useEffect(() => { agentRef.current = agent }, [agent])
  useEffect(() => () => requestRef.current?.abort(), [])

  // Keep filter changes from refetching unrelated CRM/messages or overlapping Auto.
  const fetchData = useCallback(async (range: DateRange, soft = false, force = false) => {
    if (soft && !force && requestRef.current) return
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    let timedOut = false
    const deadline = setTimeout(() => { timedOut = true; controller.abort() }, force ? 60000 : 30000)
    const options = { signal: controller.signal, cache: 'no-store' as const }
    const qs = new URLSearchParams({ platform: platformRef.current, agent: agentRef.current, ...queryDateRange(range) })
    if (force) qs.set('refresh', '1')
    if (force || soft) setRevision(value => value + 1)
    setLoading(true)
    setActivityLoading(true)
    setDepositsLoading(true)
    setSoftLoading(soft)
    if (!soft) { setData(null); setLastUpdated(null) }
    setError(null)
    // A bounded request also settles when an upstream request stops responding.
    const json = async (url: string) => {
      try {
        const res = await fetch(url, options)
        return res.ok ? await res.json() : null
      } catch { return null }
    }
    const aborted = new Promise<null>(resolve => controller.signal.addEventListener('abort', () => resolve(null), { once: true }))
    const fetchJson = (url: string) => Promise.race([json(url), aborted])
    try {
      const cached = auxRef.current
      const reuseAux = !force && cached && Date.now() - cached.at < AUTO_REFRESH_INTERVAL
      const partial: DashboardData = { activity: null, deposits: null, casino: null,
        crmAvailable: !!reuseAux, kpis: reuseAux ? cached.crm.kpis : FALLBACK_KPIS,
        tasks: reuseAux ? cached.crm.tasks : [], msgs: reuseAux ? cached.msgs.stats ?? null : null }
      const publish = () => { if (!controller.signal.aborted) setData({ ...partial }) }
      const failed: string[] = []
      const financialTimes: number[] = []
      const recordTime = (value: unknown) => {
        const time = typeof value === 'string' ? Date.parse(value) : NaN
        if (Number.isFinite(time)) financialTimes.push(time)
      }
      let crmJson: CrmDashboardData | null = reuseAux ? cached.crm : null
      let msgsJson: { stats?: MsgsStats } | null = reuseAux ? cached.msgs : null
      const jobs = [
        async () => {
          const prepared = takeDashboardPrefetch(userIdRef.current, qs)
          const result = await (prepared ? Promise.race([prepared, aborted]) : fetchJson(`/api/dashboard/casino?${qs}`)) as Awaited<ReturnType<typeof json>>
          if (controller.signal.aborted) return
          recordTime(result?.updatedAt)
          partial.casino = result ? { summary: result.summary ?? null, agentes: result.agentes ?? [],
            vips: result.vips ?? [], seg_actividad: result.seg_actividad ?? [], seg_monto: result.seg_monto ?? [],
            cash_ranking: result.cash_ranking ?? null } : null
          if (!result) failed.push('cuentas')
          publish()
        },
        async () => {
          const result = await fetchJson(`/api/dashboard/casino/overview?${qs}`)
          if (controller.signal.aborted) return
          recordTime(result?.updatedAt)
          partial.activity = result?.activity ?? null
          if (!result) failed.push('movimientos')
          publish(); setActivityLoading(false)
        },
        async () => {
          const result = await fetchJson(`/api/dashboard/casino/deposits?${qs}`)
          if (controller.signal.aborted) return
          recordTime(result?.updatedAt)
          partial.deposits = result
          if (!result) failed.push('gráficos de depósitos')
          publish(); setDepositsLoading(false)
        },
        ...(!reuseAux ? [
          async () => {
            crmJson = await fetchJson('/api/dashboard/crm')
            if (controller.signal.aborted) return
            partial.crmAvailable = !!crmJson
            partial.kpis = crmJson?.kpis ?? FALLBACK_KPIS
            partial.tasks = crmJson?.tasks ?? []
            if (!crmJson) failed.push('CRM')
            publish()
          },
          async () => {
            msgsJson = await fetchJson('/api/dashboard')
            if (controller.signal.aborted) return
            partial.msgs = msgsJson?.stats ?? null
            if (!msgsJson) failed.push('mensajería')
            publish()
          },
        ] : []),
      ]
      // At most two requests compete for the DB pool. Each finished block is
      // rendered immediately and its slot starts the next job, even if the other
      // request is slow. A timeout/filter change cannot start any queued work.
      let nextJob = 0
      const worker = async () => {
        while (!controller.signal.aborted && nextJob < jobs.length) await jobs[nextJob++]()
      }
      await Promise.all([worker(), worker()])
      if (controller.signal.aborted) return
      if (!reuseAux && crmJson && msgsJson) auxRef.current = { crm: crmJson, msgs: msgsJson, at: Date.now() }
      if (failed.length) setError(`No se pudieron consultar: ${failed.join(', ')}. Los bloques disponibles se muestran por separado.`)
      if (!failed.length) setLastUpdated(new Date(Math.min(Date.now(), ...financialTimes)))
      if (soft && !failed.length) setSoftSuccessCount(c => c + 1)
    } finally {
      clearTimeout(deadline)
      if (requestRef.current === controller) {
        requestRef.current = null
        if (timedOut) setError('La consulta tardó demasiado. Podés cambiar las fechas o reintentar; los bloques disponibles se conservan.')
        setSoftLoading(false); setLoading(false); setActivityLoading(false); setDepositsLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    // Coalesce rapid selection changes before they reach the server. Aborting a
    // browser request alone does not cancel already-running SQL.
    const running = requestRef.current; requestRef.current = null; running?.abort()
    setLoading(true); setActivityLoading(true); setDepositsLoading(true); setData(null)
    // Start immediately on entry; debounce only subsequent filter edits.
    const timer = setTimeout(() => { void fetchData(dateRange) }, initialFetchRef.current ? 0 : 180)
    initialFetchRef.current = false
    return () => { clearTimeout(timer); const running = requestRef.current; requestRef.current = null; running?.abort() }
  }, [dateRange.from, dateRange.to, platform, agent, fetchData])

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
  const refresh           = useCallback(() => { fetchData(dateRangeRef.current, true, true) }, [fetchData])

  return {
    layout: { ...layout, order: safeOrder() },
    data,
    loading,
    financeLoading: activityLoading || depositsLoading,
    activityLoading,
    depositsLoading,
    softLoading,
    error,
    lastUpdated,
    softSuccessCount,
    revision,
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
