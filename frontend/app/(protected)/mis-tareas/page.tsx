'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  ClipboardList, RefreshCw, Play, CheckCircle2, Eye, ExternalLink,
  AlertTriangle, Calendar, ChevronLeft, ChevronRight, Clock, Search, X,
} from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'
import { PageHeader } from '@/components/layout/PageHeader'
import { useCurrentUser } from '@/lib/useCurrentUser'
import Link from 'next/link'
import {
  type Task, type TaskLog, type TaskType, type TaskStatus,
  TYPE_LABELS, TYPE_COLORS, PRIORITY_LABELS, PRIORITY_COLORS,
  STATUS_LABELS, STATUS_COLORS, LOG_ACTION_LABELS, QUICK_ACCESS,
} from '@/lib/task-types'

// ── Toast ─────────────────────────────────────────────────────────────────────

type ToastItem = { id: number; type: 'success' | 'error'; message: string }

function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const counter = useRef(0)
  const show = useCallback((type: 'success' | 'error', message: string) => {
    const id = ++counter.current
    setToasts(prev => [...prev, { id, type, message }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4500)
  }, [])
  return {
    toasts,
    success: (m: string) => show('success', m),
    error:   (m: string) => show('error', m),
  }
}

function ToastContainer({ toasts }: { toasts: ToastItem[] }) {
  if (toasts.length === 0) return null
  return (
    <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium text-white pointer-events-auto
            ${t.type === 'success' ? 'bg-green-600' : 'bg-red-600'}`}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })
}
function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}
function isOverdue(due: string | null, status: TaskStatus) {
  if (!due || status === 'completada' || status === 'cancelada') return false
  return new Date(due) < new Date()
}

// ── Constantes ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 60_000          // 60 segundos entre cada poll
const LS_AUTO_REFRESH  = 'tasks_ar'     // clave localStorage para la preferencia

// ── KPI type ──────────────────────────────────────────────────────────────────

interface TaskStats {
  pendientes:      number
  en_progreso:     number
  completadas_hoy: number
  vencidas:        number
}

// ── Componente principal ──────────────────────────────────────────────────────

export default function MisTareasPage() {
  const { user: currentUser } = useCurrentUser()
  const toast = useToast()

  const [tasks, setTasks]     = useState<Task[]>([])
  const [total, setTotal]     = useState(0)
  const [page, setPage]       = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState('')
  const [search, setSearch]   = useState('')
  const [searchInput, setSearchInput] = useState('')

  // KPIs del servidor
  const [stats, setStats]           = useState<TaskStats | null>(null)
  const [loadingStats, setLoadingStats] = useState(false)

  // Auto-refresh: estado inicializado desde localStorage (solo en cliente)
  const [autoRefresh, setAutoRefresh] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem(LS_AUTO_REFRESH) === 'true'
  })
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Modal detalle
  const [showDetail,    setShowDetail]    = useState(false)
  const [detailTask,    setDetailTask]    = useState<Task | null>(null)
  const [detailLogs,    setDetailLogs]    = useState<TaskLog[]>([])
  const [loadingDetail, setLoadingDetail] = useState(false)

  // Modal completar
  const [showComplete,   setShowComplete]   = useState(false)
  const [completeTarget, setCompleteTarget] = useState<Task | null>(null)
  const [completionNote, setCompletionNote] = useState('')
  const [completing,     setCompleting]     = useState(false)

  // Acción en curso (para deshabilitar botón)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const limit = 50

  // ── Cargar KPIs del servidor ──────────────────────────────────────────────

  const fetchStats = useCallback(async () => {
    setLoadingStats(true)
    try {
      const data = await fetchJson<TaskStats>('/api/tasks/my/stats')
      setStats(data)
    } catch { /* no bloquear la UI si falla */ }
    finally { setLoadingStats(false) }
  }, [])

  // ── Cargar mis tareas ─────────────────────────────────────────────────────

  const fetchMyTasks = useCallback(async (p = page) => {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams()
      if (filterStatus) params.set('status', filterStatus)
      if (search)       params.set('q', search)
      params.set('page', String(p))
      const data = await fetchJson<{ tasks: Task[]; total: number }>(`/api/tasks/my?${params}`)
      setTasks(data.tasks); setTotal(data.total)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cargar tareas')
    } finally {
      setLoading(false)
    }
  }, [page, filterStatus, search])

  // Cargar KPIs al montar y tras acciones que cambian estado
  useEffect(() => { fetchStats() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchMyTasks(1); setPage(1) }, [filterStatus, search]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fetchMyTasks(page) }, [page]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-refresh de KPIs ──────────────────────────────────────────────────
  //  • Solo dispara si la pestaña está visible (document.visibilityState)
  //  • Se limpia al desmontar o al desactivar la opción

  useEffect(() => {
    if (!autoRefresh) {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
      return
    }

    intervalRef.current = setInterval(() => {
      if (document.visibilityState === 'visible') fetchStats()
    }, POLL_INTERVAL_MS)

    return () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
    }
  }, [autoRefresh, fetchStats])

  function toggleAutoRefresh() {
    setAutoRefresh(prev => {
      const next = !prev
      localStorage.setItem(LS_AUTO_REFRESH, String(next))
      return next
    })
  }

  // ── Refrescar todo (lista + KPIs) ─────────────────────────────────────────

  function refreshAll() {
    fetchMyTasks(page)
    fetchStats()
  }

  // ── Ver detalle ───────────────────────────────────────────────────────────

  async function openDetail(t: Task) {
    setDetailTask(t); setDetailLogs([]); setShowDetail(true); setLoadingDetail(true)
    try {
      const data = await fetchJson<{ task: Task; logs: TaskLog[] }>(`/api/tasks/${t.id}`)
      setDetailTask(data.task); setDetailLogs(data.logs)
    } catch { /* usar datos que ya tenemos */ }
    finally { setLoadingDetail(false) }
  }

  // ── Iniciar tarea ─────────────────────────────────────────────────────────

  async function handleStart(t: Task) {
    setActionLoading(t.id)
    try {
      await fetchJson(`/api/tasks/${t.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'en_progreso' }),
      })
      toast.success(`Tarea "${t.title}" iniciada`)
      fetchMyTasks(page)
      fetchStats()
      if (showDetail && detailTask?.id === t.id) {
        const data = await fetchJson<{ task: Task; logs: TaskLog[] }>(`/api/tasks/${t.id}`)
        setDetailTask(data.task); setDetailLogs(data.logs)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al iniciar la tarea')
    } finally {
      setActionLoading(null)
    }
  }

  // ── Completar tarea ───────────────────────────────────────────────────────

  function openCompleteModal(t: Task) {
    setCompleteTarget(t); setCompletionNote(''); setShowComplete(true)
  }

  async function handleComplete() {
    if (!completeTarget) return
    setCompleting(true)
    try {
      await fetchJson(`/api/tasks/${completeTarget.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completada', comment: completionNote.trim() || undefined }),
      })
      toast.success(`Tarea "${completeTarget.title}" completada`)
      setShowComplete(false)
      fetchMyTasks(page)
      fetchStats()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al completar la tarea')
    } finally {
      setCompleting(false)
    }
  }

  const totalPages = Math.ceil(total / limit)

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      <PageHeader
        title="Mis Tareas"
        description={currentUser?.name ? `Hola, ${currentUser.name}. Aquí están tus asignaciones.` : 'Tus tareas asignadas'}
        count={total}
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={refreshAll}
            disabled={loading || loadingStats}
            className="gap-1.5"
            title="Refrescar lista y contadores"
          >
            <RefreshCw size={14} className={(loading || loadingStats) ? 'animate-spin' : ''} />
            Refrescar todo
          </Button>
        }
      />

      {/* KPIs del servidor */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Resumen</p>
          <div className="flex items-center gap-3">

            {/* Toggle auto-refresh */}
            <label className="flex items-center gap-1.5 cursor-pointer select-none group">
              <div
                onClick={toggleAutoRefresh}
                className={`relative w-7 h-4 rounded-full transition-colors ${
                  autoRefresh ? 'bg-blue-500' : 'bg-gray-200'
                }`}
              >
                <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${
                  autoRefresh ? 'translate-x-3' : 'translate-x-0'
                }`} />
              </div>
              <span className={`text-xs transition-colors ${
                autoRefresh ? 'text-blue-500 font-medium' : 'text-gray-400 group-hover:text-gray-600'
              }`}>
                {autoRefresh ? 'Auto · cada 60s' : 'Auto'}
              </span>
            </label>

            {/* Botón refrescar manual */}
            <button
              type="button"
              onClick={fetchStats}
              disabled={loadingStats}
              title="Actualizar contadores ahora"
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 disabled:opacity-40 transition-colors"
            >
              <RefreshCw size={12} className={loadingStats ? 'animate-spin' : ''} />
              Actualizar
            </button>

          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card className="p-3">
            <div className="text-xs text-gray-500 mb-0.5">Pendientes</div>
            <div className="text-2xl font-bold text-slate-700">
              {loadingStats ? <span className="text-gray-300 text-lg">—</span> : (stats?.pendientes ?? 0)}
            </div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-gray-500 mb-0.5">En progreso</div>
            <div className="text-2xl font-bold text-blue-600">
              {loadingStats ? <span className="text-gray-300 text-lg">—</span> : (stats?.en_progreso ?? 0)}
            </div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-gray-500 mb-0.5">Completadas hoy</div>
            <div className="text-2xl font-bold text-green-600">
              {loadingStats ? <span className="text-gray-300 text-lg">—</span> : (stats?.completadas_hoy ?? 0)}
            </div>
          </Card>
          <Card className={`p-3 ${(stats?.vencidas ?? 0) > 0 ? 'border-red-200 bg-red-50' : ''}`}>
            <div className="text-xs text-gray-500 mb-0.5">Vencidas</div>
            <div className={`text-2xl font-bold ${(stats?.vencidas ?? 0) > 0 ? 'text-red-600' : 'text-gray-400'}`}>
              {loadingStats ? <span className="text-gray-300 text-lg">—</span> : (stats?.vencidas ?? 0)}
            </div>
          </Card>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {/* Búsqueda */}
        <form
          onSubmit={e => { e.preventDefault(); setSearch(searchInput.trim()) }}
          className="flex items-center gap-1"
        >
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Buscar en título o instrucciones..."
              className="pl-8 h-8 text-sm w-64"
            />
          </div>
          <Button type="submit" size="sm" variant="outline" className="h-8 text-xs">
            Buscar
          </Button>
          {search && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 text-xs gap-1"
              onClick={() => { setSearch(''); setSearchInput('') }}
            >
              <X size={12} /> Limpiar
            </Button>
          )}
        </form>

        {/* Filtro estado */}
        <Select
          value={filterStatus || 'todos'}
          onValueChange={v => setFilterStatus(v !== 'todos' && v !== null ? v : '')}
        >
          <SelectTrigger className="w-44 h-8 text-sm"><SelectValue placeholder="Filtrar por estado" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos los estados</SelectItem>
            {Object.entries(STATUS_LABELS).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Lista de tareas */}
      {loading ? (
        <div className="py-20 text-center text-sm text-gray-400">Cargando tareas...</div>
      ) : error ? (
        <div className="py-20 text-center text-sm text-red-500">{error}</div>
      ) : tasks.length === 0 ? (
        <div className="py-20 text-center">
          <ClipboardList size={44} className="mx-auto mb-3 text-gray-300" />
          <p className="text-gray-500 font-medium">
            {search
              ? `Sin resultados para "${search}"`
              : filterStatus
                ? `No hay tareas con estado "${STATUS_LABELS[filterStatus as TaskStatus]}"`
                : 'No tienes tareas asignadas por el momento'}
          </p>
          <p className="text-sm text-gray-400 mt-1">
            {!search && !filterStatus && 'Cuando el administrador te asigne una tarea, aparecerá aquí'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map(t => {
            const overdue   = isOverdue(t.due_date, t.status)
            const quickLink = QUICK_ACCESS[t.type as TaskType]

            return (
              <Card
                key={t.id}
                className={`transition-shadow hover:shadow-md ${overdue ? 'border-red-200' : ''}`}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    {/* Info principal */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <Badge className={`text-xs ${TYPE_COLORS[t.type as TaskType]}`}>
                          {TYPE_LABELS[t.type as TaskType]}
                        </Badge>
                        <Badge className={`text-xs ${PRIORITY_COLORS[t.priority]}`}>
                          {PRIORITY_LABELS[t.priority]}
                        </Badge>
                        <Badge className={`text-xs ${STATUS_COLORS[t.status]}`}>
                          {STATUS_LABELS[t.status]}
                        </Badge>
                        {overdue && (
                          <span className="flex items-center gap-1 text-xs text-red-600 font-medium">
                            <AlertTriangle size={11} /> Vencida
                          </span>
                        )}
                      </div>

                      <h3 className="font-semibold text-gray-900 leading-tight">{t.title}</h3>

                      {t.description && (
                        <p className="text-sm text-gray-600 mt-1 line-clamp-2">{t.description}</p>
                      )}

                      <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                        {t.due_date && (
                          <span className={`flex items-center gap-1 ${overdue ? 'text-red-600 font-medium' : ''}`}>
                            <Calendar size={11} />
                            Vence: {fmtDate(t.due_date)}
                          </span>
                        )}
                        {t.scheduled_at && (
                          <span className="flex items-center gap-1">
                            <Clock size={11} />
                            Inicio: {fmt(t.scheduled_at)}
                          </span>
                        )}
                        <span>Creada por: {t.created_by_name || 'Admin'}</span>
                      </div>
                    </div>

                    {/* Acciones */}
                    <div className="flex flex-col gap-2 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 gap-1.5 text-xs"
                        onClick={() => openDetail(t)}
                      >
                        <Eye size={13} /> Ver detalle
                      </Button>

                      {t.status === 'pendiente' && (
                        <Button
                          size="sm"
                          className="h-8 gap-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white"
                          onClick={() => handleStart(t)}
                          disabled={actionLoading === t.id}
                        >
                          <Play size={13} />
                          {actionLoading === t.id ? 'Iniciando...' : 'Iniciar'}
                        </Button>
                      )}

                      {t.status === 'en_progreso' && (
                        <Button
                          size="sm"
                          className="h-8 gap-1.5 text-xs bg-green-600 hover:bg-green-700 text-white"
                          onClick={() => openCompleteModal(t)}
                        >
                          <CheckCircle2 size={13} /> Completar
                        </Button>
                      )}

                      {quickLink && (t.status === 'pendiente' || t.status === 'en_progreso') && (
                        <Link href={quickLink.href}>
                          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs w-full">
                            <ExternalLink size={12} /> {quickLink.label}
                          </Button>
                        </Link>
                      )}
                    </div>
                  </div>

                  {/* Notas */}
                  {t.notes && (
                    <div className="mt-3 bg-amber-50 border border-amber-100 rounded px-3 py-2 text-xs text-amber-800">
                      <strong>Nota:</strong> {t.notes}
                    </div>
                  )}

                  {/* Fecha completada */}
                  {t.status === 'completada' && t.completed_at && (
                    <div className="mt-2 text-xs text-green-600 flex items-center gap-1">
                      <CheckCircle2 size={11} />
                      Completada el {fmt(t.completed_at)}
                      {t.completion_notes && <span className="text-gray-500"> · "{t.completion_notes}"</span>}
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Paginación */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm text-gray-500">
          <span>{total} tareas · Página {page} de {totalPages}</span>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>
              <ChevronLeft size={14} />
            </Button>
            <Button variant="ghost" size="sm" disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      )}

      {/* ── Modal: Detalle ────────────────────────────────────────────────── */}
      <Dialog open={showDetail} onOpenChange={setShowDetail}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Detalle de tarea</DialogTitle>
          </DialogHeader>
          {loadingDetail ? (
            <div className="py-10 text-center text-sm text-gray-400">Cargando...</div>
          ) : detailTask ? (
            <div className="space-y-4 pt-2">
              <div>
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <Badge className={`text-xs ${TYPE_COLORS[detailTask.type as TaskType]}`}>{TYPE_LABELS[detailTask.type as TaskType]}</Badge>
                  <Badge className={`text-xs ${PRIORITY_COLORS[detailTask.priority]}`}>{PRIORITY_LABELS[detailTask.priority]}</Badge>
                  <Badge className={`text-xs ${STATUS_COLORS[detailTask.status]}`}>{STATUS_LABELS[detailTask.status]}</Badge>
                </div>
                <h2 className="font-semibold text-lg text-gray-900">{detailTask.title}</h2>
              </div>

              {detailTask.description && (
                <div className="bg-gray-50 rounded-md p-3">
                  <p className="text-xs font-medium text-gray-500 mb-1">Instrucciones</p>
                  <p className="text-sm text-gray-800 whitespace-pre-line">{detailTask.description}</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 text-sm">
                <div><span className="text-gray-500">Fecha límite:</span> <strong className={isOverdue(detailTask.due_date, detailTask.status) ? 'text-red-600' : ''}>{fmtDate(detailTask.due_date)}</strong></div>
                <div><span className="text-gray-500">Creada por:</span> <strong>{detailTask.created_by_name || 'Admin'}</strong></div>
                {detailTask.scheduled_at && (
                  <div><span className="text-gray-500">Inicio programado:</span> <strong>{fmt(detailTask.scheduled_at)}</strong></div>
                )}
              </div>

              {detailTask.notes && (
                <div className="bg-amber-50 border border-amber-100 rounded-md p-3">
                  <p className="text-xs font-medium text-amber-700 mb-1">Notas del administrador</p>
                  <p className="text-sm text-amber-800 whitespace-pre-line">{detailTask.notes}</p>
                </div>
              )}

              {QUICK_ACCESS[detailTask.type as TaskType] && (detailTask.status === 'pendiente' || detailTask.status === 'en_progreso') && (
                <Link href={QUICK_ACCESS[detailTask.type as TaskType]!.href} onClick={() => setShowDetail(false)}>
                  <Button variant="outline" size="sm" className="gap-1.5 w-full">
                    <ExternalLink size={13} /> {QUICK_ACCESS[detailTask.type as TaskType]!.label}
                  </Button>
                </Link>
              )}

              <div className="flex gap-2">
                {detailTask.status === 'pendiente' && (
                  <Button
                    className="flex-1 gap-1.5 bg-blue-600 hover:bg-blue-700 text-white"
                    onClick={async () => {
                      await handleStart(detailTask)
                      const data = await fetchJson<{ task: Task; logs: TaskLog[] }>(`/api/tasks/${detailTask.id}`)
                      setDetailTask(data.task); setDetailLogs(data.logs)
                    }}
                    disabled={actionLoading === detailTask.id}
                  >
                    <Play size={14} />
                    {actionLoading === detailTask.id ? 'Iniciando...' : 'Iniciar tarea'}
                  </Button>
                )}
                {detailTask.status === 'en_progreso' && (
                  <Button
                    className="flex-1 gap-1.5 bg-green-600 hover:bg-green-700 text-white"
                    onClick={() => { setShowDetail(false); openCompleteModal(detailTask) }}
                  >
                    <CheckCircle2 size={14} /> Marcar como completada
                  </Button>
                )}
              </div>

              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">Historial</p>
                {detailLogs.length === 0 ? (
                  <p className="text-xs text-gray-400">Sin historial disponible</p>
                ) : (
                  <div className="space-y-2 border-l-2 border-gray-200 pl-3">
                    {detailLogs.map(log => (
                      <div key={log.id}>
                        <div className="text-xs text-gray-400">{fmt(log.created_at)}</div>
                        <div className="text-sm">
                          <span className="font-medium">{LOG_ACTION_LABELS[log.action] || log.action}</span>
                          {log.user_name && <span className="text-gray-500"> · {log.user_name}</span>}
                        </div>
                        {log.comment && (
                          <div className="text-xs text-gray-600 bg-gray-50 rounded px-2 py-1 mt-0.5 italic">
                            "{log.comment}"
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* ── Modal: Completar ──────────────────────────────────────────────── */}
      <Dialog open={showComplete} onOpenChange={setShowComplete}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-green-700">
              <CheckCircle2 size={18} /> Completar tarea
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <p className="text-sm text-gray-700">
              Estás por marcar como completada: <strong>"{completeTarget?.title}"</strong>
            </p>
            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1">
                Comentario de cierre <span className="text-gray-400 font-normal">(opcional)</span>
              </label>
              <Textarea
                value={completionNote}
                onChange={e => setCompletionNote(e.target.value)}
                placeholder="Describe brevemente lo que hiciste o el resultado obtenido..."
                rows={3}
                maxLength={2000}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowComplete(false)} disabled={completing}>
                Cancelar
              </Button>
              <Button
                onClick={handleComplete}
                disabled={completing}
                className="bg-green-600 hover:bg-green-700 text-white gap-1.5"
              >
                <CheckCircle2 size={14} />
                {completing ? 'Guardando...' : 'Confirmar completado'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ToastContainer toasts={toast.toasts} />
    </div>
  )
}
