'use client'

import { useState, useCallback, useEffect } from 'react'
import { useDashboard } from './useDashboard'
import { useToast } from './useToast'
import { DashboardHeader } from './DashboardHeader'
import { WidgetGrid } from './WidgetGrid'
import { AddWidgetModal } from './widgets/AddWidgetModal'
import { Toast } from './Toast'

export function Dashboard() {
  const {
    layout,
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
    toggleWidget,
    reorderByIds,
    setDateRange,
    toggleAutoRefresh,
    setPlatform,
    setAgent,
    refresh,
  } = useDashboard()

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
        showToast('Sync iniciado. Los datos se actualizarán en ~5 min.')
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
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto">
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
        <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-center gap-2">
          <span>⚠</span>
          {error}
          <button
            onClick={refresh}
            className="ml-auto underline text-xs hover:no-underline focus-visible:outline-none"
          >
            Reintentar
          </button>
        </div>
      )}

      {visibleWidgets.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-muted-foreground gap-3">
          <p className="text-sm">No hay widgets visibles.</p>
          <button
            onClick={() => setCustomizeOpen(true)}
            className="text-sm underline text-primary hover:no-underline focus-visible:outline-none"
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
