'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  ChevronLeft, ChevronRight, CalendarDays, Calendar, Clock, AlertTriangle,
} from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'
import { PageHeader } from '@/components/layout/PageHeader'
import { useCurrentUser } from '@/lib/useCurrentUser'
import {
  TASK_TYPES, TASK_PRIORITIES,
  type TaskType, type TaskPriority, type TaskStatus,
  TYPE_LABELS, TYPE_COLORS, PRIORITY_LABELS, PRIORITY_COLORS,
  STATUS_LABELS, STATUS_COLORS,
} from '@/lib/task-types'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CalTask {
  id: string
  title: string
  type: string
  priority: string
  status: string
  due_date: string | null
  scheduled_at: string | null
  assignees: { id: string; name: string | null; email: string }[]
}

interface DayEntry {
  task: CalTask
  isDeadline: boolean
  isStart: boolean
}

interface Operator {
  id: string
  name: string | null
  email: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DAYS_ES   = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
const MONTHS_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

const PRIORITY_DOT: Record<string, string> = {
  alta:  'bg-red-500',
  media: 'bg-yellow-400',
  baja:  'bg-green-500',
}

const PRIORITY_CHIP: Record<string, string> = {
  alta:  'bg-red-100 text-red-700',
  media: 'bg-yellow-100 text-yellow-700',
  baja:  'bg-green-100 text-green-700',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function todayStr(): string {
  return toDateStr(new Date())
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  })
}

function isOverdue(due: string | null, status: string): boolean {
  if (!due || status === 'completada' || status === 'cancelada') return false
  return new Date(due) < new Date()
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CalendarioPage() {
  const { user: currentUser } = useCurrentUser()
  const isAdmin = currentUser?.role === 'admin'

  const now = new Date()
  const [year,  setYear]  = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth()) // 0-indexed

  // Filters
  const [filterType,     setFilterType]     = useState('')
  const [filterPriority, setFilterPriority] = useState('')
  const [filterOperator, setFilterOperator] = useState('')

  // Data
  const [tasks,       setTasks]       = useState<CalTask[]>([])
  const [loading,     setLoading]     = useState(false)
  const [unscheduled, setUnscheduled] = useState<CalTask[]>([])
  const [loadingUn,   setLoadingUn]   = useState(false)
  const [operators,   setOperators]   = useState<Operator[]>([])

  // Day modal
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  // ── Fetch operators (admin only) ──────────────────────────────────────────

  useEffect(() => {
    if (!isAdmin) return
    fetchJson<{ users: Operator[] }>('/api/users?limit=200')
      .then(data => setOperators((data.users ?? []).filter(u => (u as unknown as { role: string }).role !== 'admin')))
      .catch(() => {})
  }, [isAdmin])

  // ── Compute extended date range for current visible grid ──────────────────
  //    (includes trailing/leading days from adjacent months)

  const { startISO, endISO } = useMemo(() => {
    const first    = new Date(year, month, 1)
    const last     = new Date(year, month + 1, 0)

    const startDay = first.getDay() // 0 = Sun
    const extStart = new Date(first)
    extStart.setDate(1 - startDay)
    extStart.setHours(0, 0, 0, 0)

    const endDay = last.getDay()
    const extEnd = new Date(last)
    extEnd.setDate(last.getDate() + (6 - endDay))
    extEnd.setHours(23, 59, 59, 999)

    return { startISO: extStart.toISOString(), endISO: extEnd.toISOString() }
  }, [year, month])

  // ── Fetch calendar tasks ──────────────────────────────────────────────────

  const fetchTasks = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ start: startISO, end: endISO })
      if (filterType)     params.set('type', filterType)
      if (filterPriority) params.set('priority', filterPriority)
      if (filterOperator) params.set('operator', filterOperator)
      const data = await fetchJson<{ tasks: CalTask[] }>(`/api/tasks/calendar?${params}`)
      setTasks(data.tasks ?? [])
    } catch {
      setTasks([])
    } finally {
      setLoading(false)
    }
  }, [startISO, endISO, filterType, filterPriority, filterOperator])

  // ── Fetch unscheduled tasks ───────────────────────────────────────────────

  const fetchUnscheduled = useCallback(async () => {
    setLoadingUn(true)
    try {
      const params = new URLSearchParams()
      if (filterType)     params.set('type', filterType)
      if (filterPriority) params.set('priority', filterPriority)
      if (filterOperator) params.set('operator', filterOperator)
      const data = await fetchJson<{ tasks: CalTask[] }>(`/api/tasks/unscheduled?${params}`)
      setUnscheduled(data.tasks ?? [])
    } catch {
      setUnscheduled([])
    } finally {
      setLoadingUn(false)
    }
  }, [filterType, filterPriority, filterOperator])

  useEffect(() => { fetchTasks() },       [fetchTasks])
  useEffect(() => { fetchUnscheduled() }, [fetchUnscheduled])

  // ── Build day map: task.id → DayEntry per date ────────────────────────────
  //    A task may appear on its scheduled_at day AND its due_date day
  //    (if they differ). If same day → merge into one entry.

  const dayMap = useMemo(() => {
    const map = new Map<string, DayEntry[]>()

    function addToDay(dateStr: string, task: CalTask, isDeadline: boolean, isStart: boolean) {
      if (!map.has(dateStr)) map.set(dateStr, [])
      const arr = map.get(dateStr)!
      const existing = arr.find(e => e.task.id === task.id)
      if (existing) {
        existing.isDeadline = existing.isDeadline || isDeadline
        existing.isStart    = existing.isStart    || isStart
      } else {
        arr.push({ task, isDeadline, isStart })
      }
    }

    for (const task of tasks) {
      const dueDateStr = task.due_date     ? task.due_date.slice(0, 10)     : null
      const schedStr   = task.scheduled_at ? task.scheduled_at.slice(0, 10) : null

      if (dueDateStr) addToDay(dueDateStr, task, true, schedStr === dueDateStr)
      if (schedStr && schedStr !== dueDateStr) addToDay(schedStr, task, false, true)
    }

    return map
  }, [tasks])

  // ── Build 42-cell calendar grid ───────────────────────────────────────────

  const calendarDays = useMemo(() => {
    const first    = new Date(year, month, 1)
    const startDay = first.getDay() // 0 = Sun
    const start    = new Date(first)
    start.setDate(1 - startDay)

    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      return {
        date:    d,
        dateStr: toDateStr(d),
        inMonth: d.getMonth() === month,
      }
    })
  }, [year, month])

  // ── Navigation ────────────────────────────────────────────────────────────

  function prevMonth() {
    if (month === 0) { setYear(y => y - 1); setMonth(11) }
    else             { setMonth(m => m - 1) }
    setSelectedDay(null)
  }

  function nextMonth() {
    if (month === 11) { setYear(y => y + 1); setMonth(0) }
    else              { setMonth(m => m + 1) }
    setSelectedDay(null)
  }

  function goToToday() {
    const n = new Date()
    setYear(n.getFullYear())
    setMonth(n.getMonth())
    setSelectedDay(null)
  }

  const today              = todayStr()
  const selectedDayEntries = selectedDay ? (dayMap.get(selectedDay) ?? []) : []

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      <PageHeader
        title="Calendario"
        description="Vista mensual de tareas programadas"
      />

      {/* ── Filters ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Select value={filterType || '__all'} onValueChange={v => setFilterType((v ?? '') === '__all' ? '' : (v ?? ''))}>
          <SelectTrigger className="w-40 h-8 text-sm">
            <SelectValue placeholder="Tipo" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">Todos los tipos</SelectItem>
            {TASK_TYPES.map(t => (
              <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filterPriority || '__all'} onValueChange={v => setFilterPriority((v ?? '') === '__all' ? '' : (v ?? ''))}>
          <SelectTrigger className="w-40 h-8 text-sm">
            <SelectValue placeholder="Prioridad" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">Todas las prioridades</SelectItem>
            {TASK_PRIORITIES.map(p => (
              <SelectItem key={p} value={p}>{PRIORITY_LABELS[p]}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isAdmin && operators.length > 0 && (
          <Select value={filterOperator || '__all'} onValueChange={v => setFilterOperator((v ?? '') === '__all' ? '' : (v ?? ''))}>
            <SelectTrigger className="w-44 h-8 text-sm">
              <SelectValue placeholder="Operador" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">Todos los operadores</SelectItem>
              {operators.map(op => (
                <SelectItem key={op.id} value={op.id}>
                  {op.name || op.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {(filterType || filterPriority || filterOperator) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={() => { setFilterType(''); setFilterPriority(''); setFilterOperator('') }}
          >
            Limpiar filtros
          </Button>
        )}
      </div>

      {/* ── Calendar card ─────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden mb-5">

        {/* Month navigation */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={prevMonth}>
              <ChevronLeft size={14} />
            </Button>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={nextMonth}>
              <ChevronRight size={14} />
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <CalendarDays size={14} className="text-gray-400" />
            <span className="font-semibold text-gray-800 text-sm tracking-tight">
              {MONTHS_ES[month]} {year}
            </span>
            {loading && (
              <span className="text-[11px] text-gray-400 animate-pulse">cargando...</span>
            )}
          </div>

          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs px-2.5"
            onClick={goToToday}
          >
            Hoy
          </Button>
        </div>

        {/* Day-of-week headers */}
        <div className="grid grid-cols-7 border-b border-gray-100 bg-gray-50/60">
          {DAYS_ES.map(day => (
            <div key={day} className="py-2 text-center text-[11px] font-medium text-gray-500 uppercase tracking-wide">
              {day}
            </div>
          ))}
        </div>

        {/* 42-cell grid */}
        <div className="grid grid-cols-7">
          {calendarDays.map(({ date, dateStr, inMonth }) => {
            const entries    = dayMap.get(dateStr) ?? []
            const isToday    = dateStr === today
            const isSelected = dateStr === selectedDay
            const maxChips   = 2
            const shownChips = entries.slice(0, maxChips)
            const overflow   = entries.length - maxChips

            return (
              <button
                key={dateStr}
                onClick={() => setSelectedDay(isSelected ? null : dateStr)}
                className={[
                  'relative min-h-[76px] p-1.5 border-r border-b border-gray-100 text-left',
                  'transition-colors duration-100 focus:outline-none',
                  !inMonth
                    ? 'bg-gray-50/50 hover:bg-gray-100/50'
                    : isSelected
                      ? 'bg-blue-50 ring-1 ring-inset ring-blue-200'
                      : 'bg-white hover:bg-blue-50/30',
                ].join(' ')}
              >
                {/* Day number */}
                <span
                  className={[
                    'inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium mb-1',
                    isToday
                      ? 'bg-blue-600 text-white font-bold'
                      : inMonth
                        ? 'text-gray-700'
                        : 'text-gray-300',
                  ].join(' ')}
                >
                  {date.getDate()}
                </span>

                {/* Dot row (always visible) */}
                {entries.length > 0 && (
                  <div className="flex items-center gap-0.5 mb-1">
                    {entries.slice(0, 4).map((entry, idx) => (
                      <span
                        key={`dot-${dateStr}-${entry.task.id}-${idx}`}
                        className={[
                          'w-1.5 h-1.5 rounded-full flex-shrink-0',
                          PRIORITY_DOT[entry.task.priority] ?? 'bg-gray-400',
                          entry.isDeadline ? 'opacity-100' : 'opacity-50',
                        ].join(' ')}
                      />
                    ))}
                    {entries.length > 4 && (
                      <span className="text-[9px] text-gray-400 font-medium leading-none">
                        +{entries.length - 4}
                      </span>
                    )}
                  </div>
                )}

                {/* Chip labels (small screens hide these) */}
                <div className="hidden sm:flex flex-col gap-0.5">
                  {shownChips.map(({ task, isDeadline }) => (
                    <div
                      key={`chip-${dateStr}-${task.id}-${isDeadline ? 'd' : 's'}`}
                      className={[
                        'text-[10px] leading-tight rounded px-1 py-0.5 truncate max-w-full',
                        isDeadline
                          ? PRIORITY_CHIP[task.priority] ?? 'bg-gray-100 text-gray-600'
                          : 'bg-gray-100 text-gray-500',
                      ].join(' ')}
                      title={`${task.title} — ${isDeadline ? 'fecha límite' : 'inicio programado'}`}
                    >
                      {isDeadline ? '⚑ ' : '▶ '}{task.title}
                    </div>
                  ))}
                  {overflow > 0 && (
                    <span className="text-[10px] text-gray-400 px-1">+{overflow} más</span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Legend ───────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-400 mb-6">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-red-500 inline-block opacity-100" />
          Alta prioridad
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" />
          Media prioridad
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
          Baja prioridad
        </span>
        <span className="text-gray-300">·</span>
        <span>⚑ = fecha límite</span>
        <span>▶ = inicio programado</span>
        <span className="text-gray-300">·</span>
        <span>Clic en un día para ver el detalle</span>
      </div>

      {/* ── Unscheduled tasks ─────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Calendar size={14} className="text-gray-400" />
          <h2 className="text-sm font-semibold text-gray-700">Sin fecha programada</h2>
          {unscheduled.length > 0 && (
            <Badge variant="secondary" className="text-xs h-5 px-1.5">
              {unscheduled.length}
            </Badge>
          )}
        </div>

        {loadingUn ? (
          <p className="text-sm text-gray-400 py-4">Cargando...</p>
        ) : unscheduled.length === 0 ? (
          <p className="text-sm text-gray-400 py-4">
            No hay tareas activas sin fecha programada
            {(filterType || filterPriority || filterOperator) ? ' con los filtros aplicados' : ''}
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {unscheduled.map(task => (
              <div
                key={task.id}
                className="bg-white border border-gray-200 rounded-lg p-3 hover:shadow-sm transition-shadow"
              >
                <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
                  <Badge className={`text-xs py-0 ${TYPE_COLORS[task.type as TaskType]}`}>
                    {TYPE_LABELS[task.type as TaskType]}
                  </Badge>
                  <Badge className={`text-xs py-0 ${PRIORITY_COLORS[task.priority as TaskPriority]}`}>
                    {PRIORITY_LABELS[task.priority as TaskPriority]}
                  </Badge>
                  <Badge className={`text-xs py-0 ${STATUS_COLORS[task.status as TaskStatus]}`}>
                    {STATUS_LABELS[task.status as TaskStatus]}
                  </Badge>
                </div>
                <p className="text-sm font-medium text-gray-800 leading-tight truncate">{task.title}</p>
                {task.assignees.length > 0 && (
                  <p className="text-[11px] text-gray-400 mt-1 truncate">
                    {task.assignees.map(a => a.name || a.email).join(', ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Day detail modal ──────────────────────────────────────────────────── */}
      <Dialog open={!!selectedDay} onOpenChange={open => { if (!open) setSelectedDay(null) }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <CalendarDays size={16} className="text-blue-600 shrink-0" />
              {selectedDay
                ? new Date(`${selectedDay}T12:00:00`).toLocaleDateString('es-AR', {
                    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
                  })
                : ''}
            </DialogTitle>
          </DialogHeader>

          {selectedDayEntries.length === 0 ? (
            <div className="py-10 text-center">
              <CalendarDays size={36} className="mx-auto mb-3 text-gray-200" />
              <p className="text-sm text-gray-400">No hay tareas para este día</p>
              {(filterType || filterPriority || filterOperator) && (
                <p className="text-xs text-gray-400 mt-1">Prueba limpiar los filtros</p>
              )}
            </div>
          ) : (
            <div className="space-y-2.5 pt-1">
              {selectedDayEntries.map(({ task, isDeadline, isStart }) => {
                const overdue = isOverdue(task.due_date, task.status)
                return (
                  <div
                    key={`modal-${task.id}-${isDeadline ? 'd' : 's'}`}
                    className={[
                      'border rounded-lg p-3',
                      overdue
                        ? 'border-red-200 bg-red-50/40'
                        : 'border-gray-200 bg-white',
                    ].join(' ')}
                  >
                    {/* Badges */}
                    <div className="flex items-center gap-1.5 flex-wrap mb-2">
                      <Badge className={`text-xs py-0 ${TYPE_COLORS[task.type as TaskType]}`}>
                        {TYPE_LABELS[task.type as TaskType]}
                      </Badge>
                      <Badge className={`text-xs py-0 ${PRIORITY_COLORS[task.priority as TaskPriority]}`}>
                        {PRIORITY_LABELS[task.priority as TaskPriority]}
                      </Badge>
                      <Badge className={`text-xs py-0 ${STATUS_COLORS[task.status as TaskStatus]}`}>
                        {STATUS_LABELS[task.status as TaskStatus]}
                      </Badge>

                      {/* Date type indicator */}
                      {isDeadline && isStart && (
                        <span className="text-[11px] text-blue-700 bg-blue-50 border border-blue-100 px-1.5 py-0.5 rounded font-medium">
                          Inicio y vencimiento
                        </span>
                      )}
                      {isDeadline && !isStart && (
                        <span className="text-[11px] text-orange-700 bg-orange-50 border border-orange-100 px-1.5 py-0.5 rounded font-medium">
                          ⚑ Fecha límite
                        </span>
                      )}
                      {!isDeadline && isStart && (
                        <span className="text-[11px] text-gray-600 bg-gray-100 border border-gray-200 px-1.5 py-0.5 rounded font-medium">
                          ▶ Inicio programado
                        </span>
                      )}

                      {overdue && (
                        <span className="flex items-center gap-0.5 text-[11px] text-red-600 font-medium">
                          <AlertTriangle size={10} /> Vencida
                        </span>
                      )}
                    </div>

                    {/* Title */}
                    <p className="font-semibold text-gray-900 text-sm leading-snug">{task.title}</p>

                    {/* Date details */}
                    <div className="flex flex-col gap-0.5 mt-2 text-xs text-gray-500">
                      {task.due_date && (
                        <span className={`flex items-center gap-1 ${overdue ? 'text-red-600 font-medium' : ''}`}>
                          <Calendar size={10} /> Vence: {fmtDate(task.due_date)}
                        </span>
                      )}
                      {task.scheduled_at && (
                        <span className="flex items-center gap-1">
                          <Clock size={10} /> Inicio: {fmtDate(task.scheduled_at)}
                        </span>
                      )}
                      {task.assignees.length > 0 && (
                        <span className="text-gray-400">
                          Asignado a: {task.assignees.map(a => a.name || a.email).join(', ')}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
