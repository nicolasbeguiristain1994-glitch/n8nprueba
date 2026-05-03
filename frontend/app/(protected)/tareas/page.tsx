'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  ClipboardList, Plus, Search, Pencil, Trash2, Eye, RefreshCw,
  AlertTriangle, Calendar, User, ChevronLeft, ChevronRight,
  CheckSquare, Square, X, UserCheck, BarChart2, CheckCircle2, RotateCcw,
} from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'
import { PageHeader } from '@/components/layout/PageHeader'
import { useCurrentUser } from '@/lib/useCurrentUser'
import {
  type Task, type TaskLog, type TaskType, type TaskPriority, type TaskStatus,
  TASK_TYPES, TASK_PRIORITIES, TASK_STATUSES,
  TYPE_LABELS, TYPE_COLORS, PRIORITY_LABELS, PRIORITY_COLORS,
  STATUS_LABELS, STATUS_COLORS, LOG_ACTION_LABELS,
} from '@/lib/task-types'

// ── Toast inline ──────────────────────────────────────────────────────────────

type ToastItem = { id: number; type: 'success' | 'error'; message: string }

function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const counter = useRef(0)

  const show = useCallback((type: 'success' | 'error', message: string) => {
    const id = ++counter.current
    setToasts(prev => [...prev, { id, type, message }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4500)
  }, [])

  return { toasts, success: (m: string) => show('success', m), error: (m: string) => show('error', m) }
}

function ToastContainer({ toasts }: { toasts: ToastItem[] }) {
  if (!toasts.length) return null
  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`px-4 py-3 rounded-lg shadow-lg text-sm font-medium max-w-sm ${
            t.type === 'success'
              ? 'bg-green-600 text-white'
              : 'bg-red-600 text-white'
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface UserOption  { id: string; name: string | null; email: string }
interface Campaign    { id: string; name: string }
interface ContactList { id: string; name: string; contact_count: number }
interface Line        { id: string; line_key: string; display_name: string; phone_number: string | null }

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

// ── Componente principal ──────────────────────────────────────────────────────

export default function TareasPage() {
  const { user: currentUser } = useCurrentUser()
  const toast = useToast()

  // Lista
  const [tasks, setTasks]     = useState<Task[]>([])
  const [total, setTotal]     = useState(0)
  const [page, setPage]       = useState(1)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  // Filtros
  const [filterStatus,   setFilterStatus]   = useState('')
  const [filterType,     setFilterType]     = useState('')
  const [filterPriority, setFilterPriority] = useState('')
  const [filterOperator, setFilterOperator] = useState('')
  const [search,         setSearch]         = useState('')
  const [showDeleted,    setShowDeleted]     = useState(false)

  // Datos auxiliares
  const [operators,    setOperators]    = useState<UserOption[]>([])
  const [campaigns,    setCampaigns]    = useState<Campaign[]>([])
  const [contactLists, setContactLists] = useState<ContactList[]>([])
  const [lines,        setLines]        = useState<Line[]>([])

  // Modal crear/editar
  const [showForm,    setShowForm]    = useState(false)
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [saving,      setSaving]      = useState(false)
  const [formError,   setFormError]   = useState<string | null>(null)
  const [fTitle,       setFTitle]       = useState('')
  const [fDescription, setFDescription] = useState('')
  const [fType,        setFType]        = useState<TaskType>('otro')
  const [fPriority,    setFPriority]    = useState<TaskPriority>('media')
  const [fAssignees,   setFAssignees]   = useState<string[]>([])
  const [fDueDate,     setFDueDate]     = useState('')
  const [fScheduled,   setFScheduled]   = useState('')
  const [fNotes,       setFNotes]       = useState('')
  const [fCampaignId,  setFCampaignId]  = useState('')
  const [fListId,      setFListId]      = useState('')
  const [fLineIds,     setFLineIds]     = useState<string[]>([])

  // Modal detalle
  const [showDetail,    setShowDetail]    = useState(false)
  const [detailTask,    setDetailTask]    = useState<Task | null>(null)
  const [detailLogs,    setDetailLogs]    = useState<TaskLog[]>([])
  const [loadingDetail, setLoadingDetail] = useState(false)

  // Modal eliminar
  const [showDelete,    setShowDelete]    = useState(false)
  const [deleteTarget,  setDeleteTarget]  = useState<Task | null>(null)
  const [deleteReason,  setDeleteReason]  = useState('')
  const [deleting,      setDeleting]      = useState(false)

  // Modal restaurar
  const [showRestore,   setShowRestore]   = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<Task | null>(null)
  const [restoring,     setRestoring]     = useState(false)

  // Bulk actions
  const [selected,       setSelected]       = useState<Set<string>>(new Set())
  const [showBulkPanel,  setShowBulkPanel]  = useState(false)
  const [bulkAction,     setBulkAction]     = useState<'delete' | 'reassign' | 'priority' | ''>('')
  const [bulkOperator,   setBulkOperator]   = useState('')
  const [bulkPriority,   setBulkPriority]   = useState('')
  const [bulkReason,     setBulkReason]     = useState('')
  const [bulkLoading,    setBulkLoading]    = useState(false)

  const limit      = 50
  const totalPages = Math.ceil(total / limit)

  // ── Cargar tareas ─────────────────────────────────────────────────────────

  const fetchTasks = useCallback(async (p = page) => {
    setLoading(true); setListError(null)
    try {
      const params = new URLSearchParams()
      if (filterStatus)    params.set('status',           filterStatus)
      if (filterType)      params.set('type',             filterType)
      if (filterPriority)  params.set('priority',         filterPriority)
      if (filterOperator)  params.set('operator',         filterOperator)
      if (search)          params.set('q',                search)
      if (showDeleted)     params.set('include_deleted',  'true')
      params.set('page', String(p))
      const data = await fetchJson<{ tasks: Task[]; total: number }>(`/api/tasks?${params}`)
      setTasks(data.tasks); setTotal(data.total)
      setSelected(new Set())
    } catch (e) {
      setListError(e instanceof Error ? e.message : 'Error al cargar tareas')
    } finally {
      setLoading(false)
    }
  }, [page, filterStatus, filterType, filterPriority, filterOperator, search, showDeleted])

  useEffect(() => {
    Promise.all([
      fetchJson<{ users: UserOption[] }>('/api/users?limit=200').catch(() => ({ users: [] })),
      fetchJson<{ campaigns: Campaign[] }>('/api/campaigns').catch(() => ({ campaigns: [] })),
      fetchJson<{ lists: ContactList[] }>('/api/lists').catch(() => ({ lists: [] })),
      fetchJson<{ lines: Line[] }>('/api/lines').catch(() => ({ lines: [] })),
    ]).then(([u, c, l, ln]) => {
      setOperators((u.users || []).filter(x => x.id !== currentUser?.id))
      setCampaigns(c.campaigns || [])
      setContactLists(l.lists || [])
      setLines(ln.lines || [])
    })
  }, [currentUser?.id])

  useEffect(() => { fetchTasks(1); setPage(1) },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterStatus, filterType, filterPriority, filterOperator, search, showDeleted])

  useEffect(() => { fetchTasks(page) }, [page]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Formulario crear/editar ───────────────────────────────────────────────

  function openCreate() {
    setEditingTask(null)
    setFTitle(''); setFDescription(''); setFType('otro'); setFPriority('media')
    setFAssignees([]); setFDueDate(''); setFScheduled(''); setFNotes('')
    setFCampaignId(''); setFListId(''); setFLineIds([])
    setFormError(null); setShowForm(true)
  }

  function openEdit(t: Task) {
    setEditingTask(t)
    setFTitle(t.title); setFDescription(t.description || '')
    setFType(t.type); setFPriority(t.priority)
    setFAssignees(t.assignees.map(a => a.id))
    setFDueDate(t.due_date ? t.due_date.slice(0, 16) : '')
    setFScheduled(t.scheduled_at ? t.scheduled_at.slice(0, 16) : '')
    setFNotes(t.notes || '')
    const rd = t.related_data || {}
    setFCampaignId((rd.campaign_id as string) || '')
    setFListId((rd.list_id as string) || '')
    setFLineIds(Array.isArray(rd.line_ids) ? (rd.line_ids as string[]) : [])
    setFormError(null); setShowForm(true)
  }

  async function handleSave() {
    if (!fTitle.trim()) { setFormError('El título es obligatorio'); return }
    setSaving(true); setFormError(null)
    try {
      const related_data: Record<string, unknown> = {}
      if (fType === 'difusion' || fType === 'revision') {
        if (fCampaignId) related_data.campaign_id = fCampaignId
        if (fListId)     related_data.list_id     = fListId
      }
      if (fType === 'calentamiento' && fLineIds.length) {
        related_data.line_ids = fLineIds
      }
      const body = {
        title: fTitle.trim(), description: fDescription.trim() || undefined,
        type: fType, priority: fPriority, assignees: fAssignees,
        due_date: fDueDate || undefined, scheduled_at: fScheduled || undefined,
        notes: fNotes.trim() || undefined, related_data,
      }
      if (editingTask) {
        await fetchJson(`/api/tasks/${editingTask.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        toast.success('Tarea actualizada correctamente')
      } else {
        await fetchJson('/api/tasks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        toast.success('Tarea creada y asignada')
      }
      setShowForm(false)
      fetchTasks(editingTask ? page : 1)
      if (!editingTask) setPage(1)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error al guardar'
      setFormError(msg)
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }

  // ── Detalle ───────────────────────────────────────────────────────────────

  async function openDetail(t: Task) {
    setDetailTask(t); setDetailLogs([]); setShowDetail(true); setLoadingDetail(true)
    try {
      const data = await fetchJson<{ task: Task; logs: TaskLog[] }>(`/api/tasks/${t.id}`)
      setDetailTask(data.task); setDetailLogs(data.logs)
    } catch { /* usar datos ya cargados */ }
    finally { setLoadingDetail(false) }
  }

  // ── Eliminar (soft delete) ────────────────────────────────────────────────

  function openDelete(t: Task) {
    setDeleteTarget(t); setDeleteReason(''); setShowDelete(true)
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await fetchJson(`/api/tasks/${deleteTarget.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: deleteReason.trim() }),
      })
      toast.success('Tarea eliminada')
      setShowDelete(false)
      fetchTasks(page)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al eliminar')
    } finally {
      setDeleting(false)
    }
  }

  // ── Restaurar tarea ───────────────────────────────────────────────────────

  function openRestore(t: Task) {
    setRestoreTarget(t); setShowRestore(true)
  }

  async function handleRestore() {
    if (!restoreTarget) return
    setRestoring(true)
    try {
      await fetchJson(`/api/tasks/${restoreTarget.id}/restore`, { method: 'POST' })
      toast.success(`Tarea "${restoreTarget.title}" restaurada`)
      setShowRestore(false)
      fetchTasks(page)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al restaurar')
    } finally {
      setRestoring(false)
    }
  }

  // ── Selección múltiple ────────────────────────────────────────────────────

  const activeTasks = tasks.filter(t => !t.deleted_at && t.status !== 'completada' && t.status !== 'cancelada')

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    const activeIds = activeTasks.map(t => t.id)
    if (activeIds.every(id => selected.has(id))) {
      setSelected(prev => { const n = new Set(prev); activeIds.forEach(id => n.delete(id)); return n })
    } else {
      setSelected(prev => { const n = new Set(prev); activeIds.forEach(id => n.add(id)); return n })
    }
  }

  function clearSelection() {
    setSelected(new Set()); setBulkAction(''); setBulkOperator(''); setBulkPriority('')
    setBulkReason(''); setShowBulkPanel(false)
  }

  // ── Ejecutar acción masiva ────────────────────────────────────────────────

  async function handleBulkAction() {
    if (!bulkAction) { toast.error('Selecciona una acción'); return }
    if (bulkAction === 'reassign' && !bulkOperator) { toast.error('Selecciona un operador'); return }
    if (bulkAction === 'priority' && !bulkPriority) { toast.error('Selecciona una prioridad'); return }

    setBulkLoading(true)
    try {
      const data: Record<string, unknown> = {}
      if (bulkAction === 'reassign') data.user_id  = bulkOperator
      if (bulkAction === 'priority') data.priority = bulkPriority
      if (bulkAction === 'delete')   data.reason   = bulkReason.trim()

      const res = await fetchJson<{ ok: boolean; affected: number; skipped: number }>('/api/tasks/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: bulkAction, task_ids: Array.from(selected), data }),
      })

      const label = bulkAction === 'delete' ? 'eliminadas' : bulkAction === 'reassign' ? 'reasignadas' : 'actualizadas'
      toast.success(`${res.affected} tarea(s) ${label}${res.skipped > 0 ? ` (${res.skipped} omitidas)` : ''}`)
      clearSelection()
      fetchTasks(page)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error en la acción masiva')
    } finally {
      setBulkLoading(false)
    }
  }

  const allActiveSelected = activeTasks.length > 0 && activeTasks.every(t => selected.has(t.id))

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      <ToastContainer toasts={toast.toasts} />

      <PageHeader
        title="Tareas"
        description="Asigna y supervisa trabajo operativo a los operadores"
        count={total}
        actions={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showDeleted}
                onChange={e => setShowDeleted(e.target.checked)}
                className="rounded"
              />
              Mostrar eliminadas
            </label>
            <Button onClick={openCreate} size="sm" className="gap-1.5 bg-green-600 hover:bg-green-700 text-white">
              <Plus size={15} /> Nueva tarea
            </Button>
          </div>
        }
      />

      {/* Filtros */}
      <Card className="mb-4">
        <CardContent className="py-3">
          <div className="flex flex-wrap gap-2">
            <div className="relative flex-1 min-w-44">
              <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
              <Input
                placeholder="Buscar en título o descripción..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-8 h-8 text-sm"
              />
            </div>

            <Select value={filterStatus || 'todos'} onValueChange={v => setFilterStatus(v !== 'todos' && v !== null ? v : '')}>
              <SelectTrigger className="w-40 h-8 text-sm"><SelectValue placeholder="Estado" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos los estados</SelectItem>
                {TASK_STATUSES.map(s => <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>)}
              </SelectContent>
            </Select>

            <Select value={filterType || 'todos'} onValueChange={v => setFilterType(v !== 'todos' && v !== null ? v : '')}>
              <SelectTrigger className="w-40 h-8 text-sm"><SelectValue placeholder="Tipo" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos los tipos</SelectItem>
                {TASK_TYPES.map(t => <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>)}
              </SelectContent>
            </Select>

            <Select value={filterPriority || 'todos'} onValueChange={v => setFilterPriority(v !== 'todos' && v !== null ? v : '')}>
              <SelectTrigger className="w-36 h-8 text-sm"><SelectValue placeholder="Prioridad" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todas</SelectItem>
                {TASK_PRIORITIES.map(p => <SelectItem key={p} value={p}>{PRIORITY_LABELS[p]}</SelectItem>)}
              </SelectContent>
            </Select>

            <Select value={filterOperator || 'todos'} onValueChange={v => setFilterOperator(v !== 'todos' && v !== null ? v : '')}>
              <SelectTrigger className="w-44 h-8 text-sm"><SelectValue placeholder="Operador" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos los operadores</SelectItem>
                {operators.map(u => <SelectItem key={u.id} value={u.id}>{u.name || u.email}</SelectItem>)}
              </SelectContent>
            </Select>

            <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => fetchTasks(page)}>
              <RefreshCw size={14} />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Barra de bulk actions */}
      {selected.size > 0 && (
        <Card className="mb-3 border-blue-200 bg-blue-50">
          <CardContent className="py-2.5 px-4">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm font-medium text-blue-800">
                {selected.size} tarea(s) seleccionada(s)
              </span>

              <Select
                value={bulkAction || 'ninguna'}
                onValueChange={v => setBulkAction(v !== 'ninguna' && v !== null ? v as typeof bulkAction : '')}
              >
                <SelectTrigger className="w-44 h-7 text-xs bg-white border-blue-200">
                  <SelectValue placeholder="Elegir acción..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ninguna">Elegir acción…</SelectItem>
                  <SelectItem value="delete">Eliminar seleccionadas</SelectItem>
                  <SelectItem value="reassign">Reasignar operador</SelectItem>
                  <SelectItem value="priority">Cambiar prioridad</SelectItem>
                </SelectContent>
              </Select>

              {bulkAction === 'reassign' && (
                <Select value={bulkOperator || 'ninguno'} onValueChange={v => setBulkOperator(v !== 'ninguno' && v !== null ? v : '')}>
                  <SelectTrigger className="w-44 h-7 text-xs bg-white border-blue-200">
                    <SelectValue placeholder="Seleccionar operador..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ninguno">Seleccionar operador…</SelectItem>
                    {operators.map(u => <SelectItem key={u.id} value={u.id}>{u.name || u.email}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}

              {bulkAction === 'priority' && (
                <Select value={bulkPriority || 'ninguna'} onValueChange={v => setBulkPriority(v !== 'ninguna' && v !== null ? v : '')}>
                  <SelectTrigger className="w-36 h-7 text-xs bg-white border-blue-200">
                    <SelectValue placeholder="Nueva prioridad..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ninguna">Nueva prioridad…</SelectItem>
                    {TASK_PRIORITIES.map(p => <SelectItem key={p} value={p}>{PRIORITY_LABELS[p]}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}

              {bulkAction && (
                <Button
                  size="sm"
                  className={`h-7 text-xs gap-1 ${
                    bulkAction === 'delete'
                      ? 'bg-red-600 hover:bg-red-700 text-white'
                      : 'bg-blue-600 hover:bg-blue-700 text-white'
                  }`}
                  onClick={handleBulkAction}
                  disabled={bulkLoading}
                >
                  {bulkLoading ? 'Procesando...' : (
                    <>
                      {bulkAction === 'delete'   && <><Trash2 size={12} /> Eliminar</>}
                      {bulkAction === 'reassign' && <><UserCheck size={12} /> Reasignar</>}
                      {bulkAction === 'priority' && <><BarChart2 size={12} /> Aplicar</>}
                    </>
                  )}
                </Button>
              )}

              <Button variant="ghost" size="sm" className="h-7 text-xs ml-auto" onClick={clearSelection}>
                <X size={13} className="mr-1" /> Cancelar selección
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabla */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-16 text-center text-sm text-gray-400">Cargando tareas...</div>
          ) : listError ? (
            <div className="py-16 text-center text-sm text-red-500">{listError}</div>
          ) : tasks.length === 0 ? (
            <div className="py-16 text-center">
              <ClipboardList size={36} className="mx-auto mb-3 text-gray-300" />
              <p className="text-sm text-gray-500 font-medium">No hay tareas que mostrar</p>
              <p className="text-xs text-gray-400 mt-1">Crea una nueva tarea para comenzar</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50">
                  <TableHead className="w-10">
                    <button onClick={toggleSelectAll} className="p-0.5">
                      {allActiveSelected
                        ? <CheckSquare size={15} className="text-blue-600" />
                        : <Square size={15} className="text-gray-400" />
                      }
                    </button>
                  </TableHead>
                  <TableHead className="text-xs font-medium">Tarea</TableHead>
                  <TableHead className="text-xs font-medium">Tipo</TableHead>
                  <TableHead className="text-xs font-medium">Asignado a</TableHead>
                  <TableHead className="text-xs font-medium">Prioridad</TableHead>
                  <TableHead className="text-xs font-medium">Estado</TableHead>
                  <TableHead className="text-xs font-medium">Vence</TableHead>
                  <TableHead className="text-xs font-medium">Creada</TableHead>
                  <TableHead className="text-xs font-medium text-right">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map(t => {
                  const isDeleted  = !!t.deleted_at
                  const isEditable = !isDeleted && t.status !== 'cancelada' && t.status !== 'completada'
                  const isSelected = selected.has(t.id)
                  return (
                    <TableRow
                      key={t.id}
                      className={`hover:bg-gray-50 align-top ${isDeleted ? 'opacity-50' : ''} ${isSelected ? 'bg-blue-50' : ''}`}
                    >
                      <TableCell>
                        {!isDeleted && isEditable && (
                          <button onClick={() => toggleSelect(t.id)} className="p-0.5">
                            {isSelected
                              ? <CheckSquare size={14} className="text-blue-600" />
                              : <Square size={14} className="text-gray-400" />
                            }
                          </button>
                        )}
                      </TableCell>
                      <TableCell className="max-w-52">
                        <div className="flex items-center gap-1.5">
                          <p className={`font-medium text-sm truncate ${isDeleted ? 'line-through text-gray-400' : ''}`}>
                            {t.title}
                          </p>
                          {isDeleted && <Badge className="text-xs bg-red-100 text-red-600 shrink-0">Eliminada</Badge>}
                        </div>
                        {t.description && (
                          <p className="text-xs text-gray-400 truncate mt-0.5">{t.description}</p>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge className={`text-xs ${TYPE_COLORS[t.type]}`}>{TYPE_LABELS[t.type]}</Badge>
                      </TableCell>
                      <TableCell>
                        {t.assignees.length === 0 ? (
                          <span className="text-xs text-gray-400">Sin asignar</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {t.assignees.slice(0, 2).map(a => (
                              <span key={a.id} className="text-xs bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded">
                                {a.name || a.email}
                              </span>
                            ))}
                            {t.assignees.length > 2 && (
                              <span className="text-xs text-gray-400">+{t.assignees.length - 2}</span>
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge className={`text-xs ${PRIORITY_COLORS[t.priority]}`}>
                          {PRIORITY_LABELS[t.priority]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge className={`text-xs ${STATUS_COLORS[t.status]}`}>
                          {STATUS_LABELS[t.status]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {t.due_date ? (
                          <span className={`text-xs ${isOverdue(t.due_date, t.status) ? 'text-red-600 font-medium' : 'text-gray-600'}`}>
                            {isOverdue(t.due_date, t.status) && <AlertTriangle size={11} className="inline mr-1" />}
                            {fmtDate(t.due_date)}
                          </span>
                        ) : <span className="text-xs text-gray-400">—</span>}
                      </TableCell>
                      <TableCell className="text-xs text-gray-500">{fmt(t.created_at)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="Ver detalle" onClick={() => openDetail(t)}>
                            <Eye size={13} />
                          </Button>
                          {isEditable && (
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="Editar" onClick={() => openEdit(t)}>
                              <Pencil size={13} />
                            </Button>
                          )}
                          {isDeleted ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs gap-1 text-emerald-600 hover:text-emerald-800 hover:bg-emerald-50"
                              title="Restaurar tarea"
                              onClick={() => openRestore(t)}
                            >
                              <RotateCcw size={12} /> Restaurar
                            </Button>
                          ) : (
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-500 hover:text-red-700 hover:bg-red-50" title="Eliminar" onClick={() => openDelete(t)}>
                              <Trash2 size={13} />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

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

      {/* ── Modal Crear / Editar ──────────────────────────────────────────── */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingTask ? 'Editar tarea' : 'Nueva tarea'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            {/* Título */}
            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1">Título *</label>
              <Input value={fTitle} onChange={e => setFTitle(e.target.value)} placeholder="Ej. Difusión promo fin de semana" maxLength={500} />
            </div>

            {/* Tipo + Prioridad */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium text-gray-700 block mb-1">Tipo de tarea</label>
                <Select value={fType} onValueChange={v => { if (v) setFType(v as TaskType) }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TASK_TYPES.map(t => <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700 block mb-1">Prioridad</label>
                <Select value={fPriority} onValueChange={v => { if (v) setFPriority(v as TaskPriority) }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TASK_PRIORITIES.map(p => <SelectItem key={p} value={p}>{PRIORITY_LABELS[p]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Descripción */}
            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1">Instrucciones / Descripción</label>
              <Textarea value={fDescription} onChange={e => setFDescription(e.target.value)} placeholder="Detalla qué debe hacer el operador..." rows={3} maxLength={5000} />
            </div>

            {/* Fechas */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium text-gray-700 block mb-1">
                  <Calendar size={13} className="inline mr-1" />Fecha límite
                </label>
                <Input type="datetime-local" value={fDueDate} onChange={e => setFDueDate(e.target.value)} className="text-sm" />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700 block mb-1">
                  <Calendar size={13} className="inline mr-1" />Programar inicio
                </label>
                <Input type="datetime-local" value={fScheduled} onChange={e => setFScheduled(e.target.value)} className="text-sm" />
              </div>
            </div>

            {/* Asignar a */}
            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1">
                <User size={13} className="inline mr-1" />Asignar a operadores
              </label>
              {operators.length === 0 ? (
                <p className="text-xs text-gray-400">No hay operadores disponibles</p>
              ) : (
                <div className="border rounded-md p-2 max-h-36 overflow-y-auto space-y-1">
                  {operators.map(u => (
                    <label key={u.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 px-1 py-0.5 rounded">
                      <input type="checkbox" checked={fAssignees.includes(u.id)}
                        onChange={() => setFAssignees(prev => prev.includes(u.id) ? prev.filter(x => x !== u.id) : [...prev, u.id])}
                        className="rounded" />
                      <span>{u.name || u.email}</span>
                      <span className="text-xs text-gray-400">{u.email}</span>
                    </label>
                  ))}
                </div>
              )}
              {fAssignees.length > 0 && <p className="text-xs text-gray-500 mt-1">{fAssignees.length} operador(es) seleccionado(s)</p>}
            </div>

            {/* Datos relacionados */}
            {(fType === 'difusion' || fType === 'revision') && (
              <div className="border rounded-md p-3 bg-blue-50 space-y-3">
                <p className="text-xs font-medium text-blue-700">Datos relacionados — {TYPE_LABELS[fType]}</p>
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Campaña asociada</label>
                  <Select value={fCampaignId || 'ninguna'} onValueChange={v => setFCampaignId(v !== 'ninguna' && v !== null ? v : '')}>
                    <SelectTrigger className="text-sm"><SelectValue placeholder="Seleccionar campaña..." /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ninguna">Sin campaña</SelectItem>
                      {campaigns.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs text-gray-600 block mb-1">Lista de contactos</label>
                  <Select value={fListId || 'ninguna'} onValueChange={v => setFListId(v !== 'ninguna' && v !== null ? v : '')}>
                    <SelectTrigger className="text-sm"><SelectValue placeholder="Seleccionar lista..." /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ninguna">Sin lista</SelectItem>
                      {contactLists.map(l => <SelectItem key={l.id} value={l.id}>{l.name} ({l.contact_count})</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {fType === 'calentamiento' && lines.length > 0 && (
              <div className="border rounded-md p-3 bg-orange-50">
                <p className="text-xs font-medium text-orange-700 mb-2">Líneas para calentar</p>
                <div className="max-h-36 overflow-y-auto space-y-1">
                  {lines.map(l => (
                    <label key={l.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-orange-100 px-1 py-0.5 rounded">
                      <input type="checkbox" checked={fLineIds.includes(l.id)}
                        onChange={() => setFLineIds(prev => prev.includes(l.id) ? prev.filter(x => x !== l.id) : [...prev, l.id])}
                        className="rounded" />
                      <span>{l.display_name}</span>
                      {l.phone_number && <span className="text-xs text-gray-400">{l.phone_number}</span>}
                    </label>
                  ))}
                </div>
                {fLineIds.length > 0 && <p className="text-xs text-orange-600 mt-1">{fLineIds.length} línea(s)</p>}
              </div>
            )}

            {/* Notas */}
            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1">Notas adicionales</label>
              <Textarea value={fNotes} onChange={e => setFNotes(e.target.value)} placeholder="Información adicional para el operador..." rows={2} maxLength={2000} />
            </div>

            {formError && (
              <div className="bg-red-50 text-red-700 text-sm px-3 py-2 rounded border border-red-100">{formError}</div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setShowForm(false)} disabled={saving}>Cancelar</Button>
              <Button onClick={handleSave} disabled={saving} className="bg-green-600 hover:bg-green-700 text-white">
                {saving ? 'Guardando...' : (editingTask ? 'Guardar cambios' : 'Crear tarea')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Modal Detalle ─────────────────────────────────────────────────── */}
      <Dialog open={showDetail} onOpenChange={setShowDetail}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Detalle de tarea</DialogTitle>
          </DialogHeader>
          {loadingDetail ? (
            <div className="py-10 text-center text-sm text-gray-400">Cargando...</div>
          ) : detailTask ? (
            <div className="space-y-4 pt-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-gray-900">{detailTask.title}</h2>
                  {detailTask.description && <p className="text-sm text-gray-600 mt-1 whitespace-pre-line">{detailTask.description}</p>}
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <Badge className={`text-xs ${STATUS_COLORS[detailTask.status]}`}>{STATUS_LABELS[detailTask.status]}</Badge>
                  <Badge className={`text-xs ${PRIORITY_COLORS[detailTask.priority]}`}>{PRIORITY_LABELS[detailTask.priority]}</Badge>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm border rounded-md p-3 bg-gray-50">
                <div><span className="text-gray-500">Tipo:</span> <strong>{TYPE_LABELS[detailTask.type]}</strong></div>
                <div><span className="text-gray-500">Creada por:</span> <strong>{detailTask.created_by_name || '—'}</strong></div>
                <div><span className="text-gray-500">Fecha límite:</span> <strong className={isOverdue(detailTask.due_date, detailTask.status) ? 'text-red-600' : ''}>{fmtDate(detailTask.due_date)}</strong></div>
                <div><span className="text-gray-500">Creada el:</span> <strong>{fmt(detailTask.created_at)}</strong></div>
                {detailTask.completed_at && <div><span className="text-gray-500">Completada:</span> <strong>{fmt(detailTask.completed_at)}</strong></div>}
                {detailTask.deleted_at   && <div><span className="text-gray-500">Eliminada:</span>  <strong className="text-red-600">{fmt(detailTask.deleted_at)}</strong></div>}
              </div>

              <div>
                <p className="text-sm font-medium text-gray-700 mb-1">Asignada a</p>
                {detailTask.assignees.length === 0 ? <p className="text-sm text-gray-400">Sin asignar</p> : (
                  <div className="flex flex-wrap gap-1.5">
                    {detailTask.assignees.map(a => (
                      <span key={a.id} className="text-xs bg-blue-50 text-blue-700 border border-blue-100 px-2 py-1 rounded-full">{a.name || a.email}</span>
                    ))}
                  </div>
                )}
              </div>

              {detailTask.completion_notes && (
                <div className="bg-green-50 border border-green-100 rounded-md p-3">
                  <p className="text-xs font-medium text-green-700 mb-1">Comentario de cierre</p>
                  <p className="text-sm text-green-800 whitespace-pre-line">{detailTask.completion_notes}</p>
                </div>
              )}
              {detailTask.cancel_reason && (
                <div className="bg-red-50 border border-red-100 rounded-md p-3">
                  <p className="text-xs font-medium text-red-700 mb-1">Motivo</p>
                  <p className="text-sm text-red-800">{detailTask.cancel_reason}</p>
                </div>
              )}
              {detailTask.notes && (
                <div className="bg-amber-50 border border-amber-100 rounded-md p-3">
                  <p className="text-xs font-medium text-amber-700 mb-1">Notas</p>
                  <p className="text-sm text-amber-800 whitespace-pre-line">{detailTask.notes}</p>
                </div>
              )}

              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">Historial</p>
                {detailLogs.length === 0 ? (
                  <p className="text-xs text-gray-400">Sin historial</p>
                ) : (
                  <div className="space-y-2 border-l-2 border-gray-200 pl-3">
                    {detailLogs.map(log => (
                      <div key={log.id} className="relative">
                        <div className="absolute -left-[17px] top-1.5 w-2.5 h-2.5 rounded-full bg-gray-300 border-2 border-white" />
                        <div className="text-xs text-gray-500">{fmt(log.created_at)}</div>
                        <div className="text-sm">
                          <span className="font-medium">{LOG_ACTION_LABELS[log.action] || log.action}</span>
                          {log.user_name && <span className="text-gray-500"> por {log.user_name}</span>}
                        </div>
                        {log.comment && (
                          <div className="text-xs text-gray-600 bg-gray-50 rounded px-2 py-1 mt-0.5 italic">"{log.comment}"</div>
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

      {/* ── Modal Eliminar (soft delete) ──────────────────────────────────── */}
      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-700">
              <AlertTriangle size={18} /> Eliminar tarea
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <p className="text-sm text-gray-700">
              ¿Confirmas la eliminación de <strong>"{deleteTarget?.title}"</strong>?
              La tarea quedará oculta pero podrás verla activando "Mostrar eliminadas".
            </p>
            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1">Motivo (opcional)</label>
              <Textarea value={deleteReason} onChange={e => setDeleteReason(e.target.value)} rows={2} maxLength={500} placeholder="Explica por qué se elimina..." />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowDelete(false)} disabled={deleting}>Volver</Button>
              <Button onClick={handleDelete} disabled={deleting} className="bg-red-600 hover:bg-red-700 text-white">
                {deleting ? 'Eliminando...' : 'Confirmar eliminación'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Modal Restaurar ───────────────────────────────────────────────── */}
      <Dialog open={showRestore} onOpenChange={setShowRestore}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-emerald-700">
              <RotateCcw size={18} /> Restaurar tarea
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <p className="text-sm text-gray-700">
              ¿Restaurar <strong>"{restoreTarget?.title}"</strong>?
              La tarea volverá a aparecer en la lista y el operador podrá verla.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowRestore(false)} disabled={restoring}>
                Cancelar
              </Button>
              <Button
                onClick={handleRestore}
                disabled={restoring}
                className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
              >
                <RotateCcw size={14} />
                {restoring ? 'Restaurando...' : 'Confirmar restauración'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
