'use client'

import Link from 'next/link'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { useState, useCallback, useEffect } from 'react'
import { queryDateRange } from '@/lib/dashboard-date-range'
import { useDashboard } from './useDashboard'
import { useToast } from './useToast'
import { DashboardHeader } from './DashboardHeader'
import { DepositCharts } from './DepositCharts'
import { PlatformOverview } from './PlatformOverview'
import { NewUsersByAgent } from './NewUsersByAgent'
import { CashRanking } from './CashRanking'
import { WidgetGrid } from './WidgetGrid'
import { AddWidgetModal } from './widgets/AddWidgetModal'
import { Toast } from './Toast'
import { ArrowRight, CheckCircle2, ClipboardList } from 'lucide-react'

export function Dashboard() {
  const {user} = useCurrentUser()
  const {
    layout,
    data,
    loading,
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
    toggleWidget,
    reorderByIds,
    setDateRange,
    toggleAutoRefresh,
    setPlatform,
    setAgent,
    refresh,
  } = useDashboard()

  const includedDays = queryDateRange(dateRange)
  const { toast, showToast } = useToast()
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const [syncStatus, setSyncStatus] = useState<'idle' | 'loading'>('idle')

  const handleSyncCasino = useCallback(async () => {
    setSyncStatus('loading')
    try {
      const platforms = platform === 'consolidado' ? ['zeus', 'bet30'] : [platform]
      const results = await Promise.all(
        platforms.map(p => fetch(`/api/dashboard/casino/sync?platform=${p}`, { method: 'POST' })),
      )
      const allOk = results.every(r => r.ok)
      if (allOk) {
        // La API solo confirma el arranque del proceso.
        showToast('Sincronización iniciada. Los datos se actualizarán cuando termine.')
      } else {
        const failed = results.find(r => !r.ok)
        const json = failed ? await failed.json() : {}
        showToast(json.error ?? 'Error al iniciar el sync')
      }
    } catch {
      showToast('Error de red al intentar sincronizar')
    } finally {
      setSyncStatus('idle')
    }
  }, [platform, showToast])

  // Mostrar toast en cada soft-refresh exitoso (softSuccessCount incrementa con cada éxito)
  useEffect(() => {
    if (softSuccessCount > 0) showToast('Dashboard actualizado')
  }, [softSuccessCount]) // showToast es estable, omisión intencional

  const handleTaskCompleted = useCallback(() => {
    setTimeout(refresh, 500)
  }, [refresh])

  return (
    <div className="min-w-0 mx-auto">
      <DashboardHeader
        loading={loading}
        softLoading={softLoading}
        lastUpdated={lastUpdated}
        dateRange={dateRange}
        autoRefreshEnabled={autoRefreshEnabled}
        platform={platform}
        agent={agent}
        syncStatus={syncStatus}
        onCustomize={() => setCustomizeOpen(true)}
        onRefresh={refresh}
        onDateRangeChange={setDateRange}
        onAutoRefreshToggle={toggleAutoRefresh}
        onPlatformChange={setPlatform}
        onAgentChange={setAgent}
        onSyncCasino={handleSyncCasino}
      />

      {error && (
        <div role="alert" className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-center gap-2">
          <span>⚠</span>
          {error}
          <button
            onClick={refresh}
            className="ml-auto underline text-xs hover:no-underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Reintentar
          </button>
        </div>
      )}

      {data?.crmAvailable && (user?.role==='admin'||user?.sectors?.includes('tasks')) && <Link href={user?.role==='admin'?'/tareas':'/mis-tareas'} className="surface mb-5 flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3.5 text-sm transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="flex items-center gap-2.5 font-medium">{data.kpis.tasks_pending === 0 ? <CheckCircle2 size={20} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" /> : <ClipboardList size={20} className="text-primary" aria-hidden="true" />}{data.kpis.tasks_pending === 0 ? 'Sin tareas pendientes' : 'Trabajo pendiente'}</span>
        {data.kpis.tasks_pending > 0 && <span className="text-muted-foreground"><strong className="font-semibold text-foreground tabular-nums">{data.kpis.tasks_pending}</strong> tareas pendientes</span>}
        {data.kpis.tasks_overdue > 0 && <span className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive"><strong className="tabular-nums">{data.kpis.tasks_overdue}</strong> vencidas</span>}
        <span className="ml-auto flex items-center gap-2 font-medium text-primary">Abrir tareas <ArrowRight size={16} aria-hidden="true" /></span>
      </Link>}

      <NewUsersByAgent agentes={data?.casino?.agentes ?? null} loading={loading && !data?.casino}
        dateRange={dateRange} platform={platform} agent={agent} />

      {/* PlatformOverview labels "from al to" inclusively: give it the days actually queried. */}
      <PlatformOverview activity={data?.activity ?? null} platform={platform} agent={agent} from={includedDays.from} to={includedDays.to} loading={activityLoading} />

      <CashRanking rows={data?.casino?.cash_ranking ?? null} loading={loading && !data?.casino} />

      <DepositCharts data={data?.deposits ?? null} loading={depositsLoading} />

      {visibleWidgets.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-3">
          <p className="text-sm">No hay widgets visibles.</p>
          <button
            onClick={() => setCustomizeOpen(true)}
            className="text-sm underline text-primary hover:no-underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Personalizar dashboard
          </button>
        </div>
      ) : (
        <WidgetGrid
          visibleWidgets={visibleWidgets}
          data={data}
          loading={loading}
          platform={platform}
          agent={agent}
          dateRange={dateRange}
          revision={revision}
          onReorder={reorderByIds}
          onTaskCompleted={handleTaskCompleted}
        />
      )}

      <AddWidgetModal
        open={customizeOpen}
        onClose={() => setCustomizeOpen(false)}
        hidden={layout.hidden ?? []}
        onToggle={toggleWidget}
      />

      <Toast visible={toast.visible} message={toast.message} />
    </div>
  )
}
