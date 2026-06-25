'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Button }   from '@/components/ui/button'
import { Badge }    from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input }    from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label }    from '@/components/ui/label'
import {
  ChevronLeft, ChevronRight, CalendarDays, Calendar, Clock, AlertTriangle,
  Megaphone, Pencil, Trash2, Plus, ImageIcon,
} from 'lucide-react'
import { fetchJson }      from '@/lib/fetchJson'
import { PageHeader }     from '@/components/layout/PageHeader'
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

interface MarketingEntry {
  id: string
  date: string          // YYYY-MM-DD
  hour: number | null   // 0-23, null = todo el día
  title: string
  consigna: string | null
  image_url: string | null
  created_by: string | null
  creator_name: string | null
  created_at: string
}

interface MarketingForm {
  date: string
  hour: string          // '' = todo el día, '0'..'23' = hora
  title: string
  consigna: string
  imageMode: 'url' | 'upload'
  imageUrl: string
  imagePreview: string  // base64 o URL para preview
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

const HOUR_LABELS = Array.from({ length: 24 }, (_, i) =>
  `${String(i).padStart(2, '0')}:00`
)

const EMPTY_FORM: MarketingForm = {
  date: '', hour: '', title: '', consigna: '',
  imageMode: 'url', imageUrl: '', imagePreview: '',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDateStr(d: Date): string {
  const y   = d.getFullYear()
  const m   = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function todayStr(): string { return toDateStr(new Date()) }

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  })
}

function fmtDateLong(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString('es-AR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
}

function isOverdue(due: string | null, status: string): boolean {
  if (!due || status === 'completada' || status === 'cancelada') return false
  return new Date(due) < new Date()
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CalendarioPage() {
  const { user: currentUser }   = useCurrentUser()
  const isAdmin                 = currentUser?.role === 'admin'
  const canEditMarketing        = currentUser?.role === 'admin' || currentUser?.role === 'operator'
  const fileRef                 = useRef<HTMLInputElement>(null)

  // ── View mode ──────────────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<'month' | 'day'>('month')

  // ── Month view ─────────────────────────────────────────────────────────────
  const now = new Date()
  const [year,  setYear]  = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())

  // ── Day view ───────────────────────────────────────────────────────────────
  const [dayViewDate, setDayViewDate] = useState(toDateStr(now))

  // ── Filters ────────────────────────────────────────────────────────────────
  const [filterType,     setFilterType]     = useState('')
  const [filterPriority, setFilterPriority] = useState('')
  const [filterOperator, setFilterOperator] = useState('')

  // ── Task data ──────────────────────────────────────────────────────────────
  const [tasks,       setTasks]       = useState<CalTask[]>([])
  const [loading,     setLoading]     = useState(false)
  const [unscheduled, setUnscheduled] = useState<CalTask[]>([])
  const [loadingUn,   setLoadingUn]   = useState(false)
  const [operators,   setOperators]   = useState<Operator[]>([])

  // ── Marketing data ─────────────────────────────────────────────────────────
  const [marketing,    setMarketing]    = useState<MarketingEntry[]>([])
  const [showMktModal, setShowMktModal] = useState(false)
  const [editingMkt,   setEditingMkt]   = useState<MarketingEntry | null>(null)
  const [mktForm,      setMktForm]      = useState<MarketingForm>(EMPTY_FORM)
  const [savingMkt,    setSavingMkt]    = useState(false)
  const [mktError,     setMktError]     = useState('')

  // ── Day modal ──────────────────────────────────────────────────────────────
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  // ── Fetch operators (admin only) ──────────────────────────────────────────

  useEffect(() => {
    if (!isAdmin) return
    fetchJson<{ users: Operator[] }>('/api/users?limit=200')
      .then(data => setOperators((data.users ?? []).filter(u => (u as unknown as { role: string }).role !== 'admin')))
      .catch(() => {})
  }, [isAdmin])

  // ── Extended date range for grid ──────────────────────────────────────────

  const { startISO, endISO, startDate, endDate } = useMemo(() => {
    const first    = new Date(year, month, 1)
    const last     = new Date(year, month + 1, 0)
    const startDay = first.getDay()
    const extStart = new Date(first)
    extStart.setDate(1 - startDay)
    extStart.setHours(0, 0, 0, 0)
    const endDay = last.getDay()
    const extEnd = new Date(last)
    extEnd.setDate(last.getDate() + (6 - endDay))
    extEnd.setHours(23, 59, 59, 999)
    return {
      startISO:  extStart.toISOString(),
      endISO:    extEnd.toISOString(),
      startDate: toDateStr(extStart),
      endDate:   toDateStr(extEnd),
    }
  }, [year, month])

  // ── Fetch tasks ───────────────────────────────────────────────────────────

  const fetchTasks = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ start: startISO, end: endISO })
      if (filterType)     params.set('type',     filterType)
      if (filterPriority) params.set('priority', filterPriority)
      if (filterOperator) params.set('operator', filterOperator)
      const data = await fetchJson<{ tasks: CalTask[] }>(`/api/tasks/calendar?${params}`)
      setTasks(data.tasks ?? [])
    } catch { setTasks([]) }
    finally  { setLoading(false) }
  }, [startISO, endISO, filterType, filterPriority, filterOperator])

  const fetchUnscheduled = useCallback(async () => {
    setLoadingUn(true)
    try {
      const params = new URLSearchParams()
      if (filterType)     params.set('type',     filterType)
      if (filterPriority) params.set('priority', filterPriority)
      if (filterOperator) params.set('operator', filterOperator)
      const data = await fetchJson<{ tasks: CalTask[] }>(`/api/tasks/unscheduled?${params}`)
      setUnscheduled(data.tasks ?? [])
    } catch { setUnscheduled([]) }
    finally  { setLoadingUn(false) }
  }, [filterType, filterPriority, filterOperator])

  // ── Fetch marketing ───────────────────────────────────────────────────────
  // Carga el rango del mes visible (aplica a ambas vistas)

  const fetchMarketing = useCallback(async () => {
    try {
      const params = new URLSearchParams({ start: startDate, end: endDate })
      const data   = await fetchJson<{ entries: MarketingEntry[] }>(`/api/marketing-calendar?${params}`)
      setMarketing(data.entries ?? [])
    } catch { setMarketing([]) }
  }, [startDate, endDate])

  useEffect(() => { fetchTasks() },       [fetchTasks])
  useEffect(() => { fetchUnscheduled() }, [fetchUnscheduled])
  useEffect(() => { fetchMarketing() },   [fetchMarketing])

  // ── dayMap ────────────────────────────────────────────────────────────────

  const dayMap = useMemo(() => {
    const map = new Map<string, DayEntry[]>()
    function addToDay(dateStr: string, task: CalTask, isDeadline: boolean, isStart: boolean) {
      if (!map.has(dateStr)) map.set(dateStr, [])
      const arr = map.get(dateStr)!
      const ex  = arr.find(e => e.task.id === task.id)
      if (ex) { ex.isDeadline = ex.isDeadline || isDeadline; ex.isStart = ex.isStart || isStart }
      else    { arr.push({ task, isDeadline, isStart }) }
    }
    for (const task of tasks) {
      const due  = task.due_date     ? task.due_date.slice(0, 10)     : null
      const sched = task.scheduled_at ? task.scheduled_at.slice(0, 10) : null
      if (due)              addToDay(due,   task, true,          sched === due)
      if (sched && sched !== due) addToDay(sched, task, false, true)
    }
    return map
  }, [tasks])

  // ── Marketing grouped by date ─────────────────────────────────────────────

  const marketingByDate = useMemo(() => {
    const map = new Map<string, MarketingEntry[]>()
    for (const e of marketing) {
      if (!map.has(e.date)) map.set(e.date, [])
      map.get(e.date)!.push(e)
    }
    return map
  }, [marketing])

  // ── Calendar grid (42 cells) ──────────────────────────────────────────────

  const calendarDays = useMemo(() => {
    const first    = new Date(year, month, 1)
    const startDay = first.getDay()
    const start    = new Date(first)
    start.setDate(1 - startDay)
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      return { date: d, dateStr: toDateStr(d), inMonth: d.getMonth() === month }
    })
  }, [year, month])

  // ── Navigation ────────────────────────────────────────────────────────────

  function prevMonth() {
    if (month === 0) { setYear(y => y - 1); setMonth(11) } else { setMonth(m => m - 1) }
    setSelectedDay(null)
  }
  function nextMonth() {
    if (month === 11) { setYear(y => y + 1); setMonth(0) } else { setMonth(m => m + 1) }
    setSelectedDay(null)
  }
  function goToToday() {
    const n = new Date()
    setYear(n.getFullYear()); setMonth(n.getMonth())
    setDayViewDate(toDateStr(n)); setSelectedDay(null)
  }
  function prevDay() {
    const d = new Date(`${dayViewDate}T12:00:00`)
    d.setDate(d.getDate() - 1); setDayViewDate(toDateStr(d))
  }
  function nextDay() {
    const d = new Date(`${dayViewDate}T12:00:00`)
    d.setDate(d.getDate() + 1); setDayViewDate(toDateStr(d))
  }

  const today              = todayStr()
  const selectedDayEntries = selectedDay ? (dayMap.get(selectedDay) ?? []) : []
  const selectedDayMkt     = selectedDay ? (marketingByDate.get(selectedDay) ?? []) : []
  const dayViewMkt         = marketingByDate.get(dayViewDate) ?? []

  // ── Marketing modal helpers ───────────────────────────────────────────────

  function openAddMarketing(date: string, hour?: number) {
    setEditingMkt(null)
    setMktForm({ ...EMPTY_FORM, date, hour: hour !== undefined ? String(hour) : '' })
    setMktError('')
    setShowMktModal(true)
  }

  function openEditMarketing(entry: MarketingEntry) {
    setEditingMkt(entry)
    setMktForm({
      date:         entry.date,
      hour:         entry.hour !== null ? String(entry.hour) : '',
      title:        entry.title,
      consigna:     entry.consigna ?? '',
      imageMode:    'url',
      imageUrl:     entry.image_url ?? '',
      imagePreview: entry.image_url ?? '',
    })
    setMktError('')
    setShowMktModal(true)
  }

  async function handleSaveMkt() {
    if (!mktForm.title.trim() || !mktForm.date) {
      setMktError('El título y la fecha son obligatorios')
      return
    }
    setSavingMkt(true); setMktError('')
    try {
      const imageUrl = mktForm.imageMode === 'url' ? mktForm.imageUrl.trim() : mktForm.imagePreview
      const body = {
        date:      mktForm.date,
        hour:      mktForm.hour !== '' ? parseInt(mktForm.hour) : null,
        title:     mktForm.title.trim(),
        consigna:  mktForm.consigna.trim() || null,
        image_url: imageUrl || null,
      }
      const url    = editingMkt ? `/api/marketing-calendar/${editingMkt.id}` : '/api/marketing-calendar'
      const method = editingMkt ? 'PUT' : 'POST'
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) throw new Error('Error al guardar')
      setShowMktModal(false); setEditingMkt(null)
      fetchMarketing()
    } catch {
      setMktError('No se pudo guardar. Intentá de nuevo.')
    } finally {
      setSavingMkt(false)
    }
  }

  async function handleDeleteMkt(id: string) {
    if (!confirm('¿Eliminar esta entrada de marketing?')) return
    try {
      await fetch(`/api/marketing-calendar/${id}`, { method: 'DELETE' })
      fetchMarketing()
    } catch {}
  }

  function handleImageFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 3 * 1024 * 1024) { setMktError('La imagen no puede superar 3 MB'); return }
    const reader = new FileReader()
    reader.onload = ev => setMktForm(f => ({ ...f, imagePreview: ev.target?.result as string ?? '' }))
    reader.readAsDataURL(file)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      <PageHeader title="Calendario" description="Vista mensual de tareas programadas" />

      {/* ── View mode toggle ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden text-xs">
          <button
            onClick={() => setViewMode('month')}
            className={[
              'flex items-center gap-1.5 px-3 py-1.5 font-medium transition-colors',
              viewMode === 'month' ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50',
            ].join(' ')}
          >
            <CalendarDays size={12} /> Mensual
          </button>
          <button
            onClick={() => setViewMode('day')}
            className={[
              'flex items-center gap-1.5 px-3 py-1.5 font-medium transition-colors',
              viewMode === 'day' ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50',
            ].join(' ')}
          >
            <Clock size={12} /> Por día / hora
          </button>
        </div>
      </div>

      {/* ── Filters ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Select value={filterType || '__all'} onValueChange={v => setFilterType(v === '__all' ? '' : v)}>
          <SelectTrigger className="w-40 h-8 text-sm"><SelectValue placeholder="Tipo" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">Todos los tipos</SelectItem>
            {TASK_TYPES.map(t => <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={filterPriority || '__all'} onValueChange={v => setFilterPriority(v === '__all' ? '' : v)}>
          <SelectTrigger className="w-40 h-8 text-sm"><SelectValue placeholder="Prioridad" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">Todas las prioridades</SelectItem>
            {TASK_PRIORITIES.map(p => <SelectItem key={p} value={p}>{PRIORITY_LABELS[p]}</SelectItem>)}
          </SelectContent>
        </Select>

        {isAdmin && operators.length > 0 && (
          <Select value={filterOperator || '__all'} onValueChange={v => setFilterOperator(v === '__all' ? '' : v)}>
            <SelectTrigger className="w-44 h-8 text-sm"><SelectValue placeholder="Operador" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">Todos los operadores</SelectItem>
              {operators.map(op => <SelectItem key={op.id} value={op.id}>{op.name || op.email}</SelectItem>)}
            </SelectContent>
          </Select>
        )}

        {(filterType || filterPriority || filterOperator) && (
          <Button variant="ghost" size="sm" className="h-8 text-xs"
            onClick={() => { setFilterType(''); setFilterPriority(''); setFilterOperator('') }}>
            Limpiar filtros
          </Button>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* MONTHLY VIEW                                                      */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      {viewMode === 'month' && (
        <>
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden mb-5">
            {/* Month nav */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={prevMonth}><ChevronLeft size={14} /></Button>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={nextMonth}><ChevronRight size={14} /></Button>
              </div>
              <div className="flex items-center gap-2">
                <CalendarDays size={14} className="text-gray-400" />
                <span className="font-semibold text-gray-800 text-sm tracking-tight">{MONTHS_ES[month]} {year}</span>
                {loading && <span className="text-[11px] text-gray-400 animate-pulse">cargando...</span>}
              </div>
              <Button variant="outline" size="sm" className="h-7 text-xs px-2.5" onClick={goToToday}>Hoy</Button>
            </div>

            {/* Day headers */}
            <div className="grid grid-cols-7 border-b border-gray-100 bg-gray-50/60">
              {DAYS_ES.map(day => (
                <div key={day} className="py-2 text-center text-[11px] font-medium text-gray-500 uppercase tracking-wide">{day}</div>
              ))}
            </div>

            {/* 42-cell grid */}
            <div className="grid grid-cols-7">
              {calendarDays.map(({ date, dateStr, inMonth }) => {
                const entries    = dayMap.get(dateStr) ?? []
                const mktEntries = marketingByDate.get(dateStr) ?? []
                const isToday    = dateStr === today
                const isSelected = dateStr === selectedDay
                const shown      = entries.slice(0, 2)
                const overflow   = entries.length - 2

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
                    <span className={[
                      'inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium mb-0.5',
                      isToday ? 'bg-blue-600 text-white font-bold' : inMonth ? 'text-gray-700' : 'text-gray-300',
                    ].join(' ')}>
                      {date.getDate()}
                    </span>

                    {/* Task priority dots */}
                    {entries.length > 0 && (
                      <div className="flex items-center gap-0.5 mb-0.5">
                        {entries.slice(0, 4).map((entry, idx) => (
                          <span key={`dot-${dateStr}-${entry.task.id}-${idx}`}
                            className={['w-1.5 h-1.5 rounded-full flex-shrink-0',
                              PRIORITY_DOT[entry.task.priority] ?? 'bg-gray-400',
                              entry.isDeadline ? 'opacity-100' : 'opacity-50'].join(' ')}
                          />
                        ))}
                        {entries.length > 4 && <span className="text-[9px] text-gray-400">+{entries.length - 4}</span>}
                      </div>
                    )}

                    {/* Marketing indicator */}
                    {mktEntries.length > 0 && inMonth && (
                      <div className="flex items-center gap-0.5 mb-0.5">
                        <Megaphone size={9} className="text-purple-500 shrink-0" />
                        <span className="text-[9px] text-purple-600 font-semibold leading-none">{mktEntries.length}</span>
                      </div>
                    )}

                    {/* Task chips */}
                    <div className="hidden sm:flex flex-col gap-0.5">
                      {shown.map(({ task, isDeadline }) => (
                        <div key={`chip-${dateStr}-${task.id}-${isDeadline ? 'd' : 's'}`}
                          className={['text-[10px] leading-tight rounded px-1 py-0.5 truncate max-w-full',
                            isDeadline ? PRIORITY_CHIP[task.priority] ?? 'bg-gray-100 text-gray-600' : 'bg-gray-100 text-gray-500'].join(' ')}
                          title={`${task.title} — ${isDeadline ? 'fecha límite' : 'inicio programado'}`}
                        >
                          {isDeadline ? '⚑ ' : '▶ '}{task.title}
                        </div>
                      ))}
                      {overflow > 0 && <span className="text-[10px] text-gray-400 px-1">+{overflow} más</span>}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Legend */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-400 mb-6">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> Alta prioridad</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" /> Media prioridad</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 inline-block" /> Baja prioridad</span>
            <span className="text-gray-300">·</span>
            <span>⚑ = fecha límite</span>
            <span>▶ = inicio programado</span>
            <span className="flex items-center gap-1"><Megaphone size={10} className="text-purple-500" /> Marketing</span>
            <span className="text-gray-300">·</span>
            <span>Clic en un día para ver el detalle</span>
          </div>

          {/* Unscheduled tasks */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Calendar size={14} className="text-gray-400" />
              <h2 className="text-sm font-semibold text-gray-700">Sin fecha programada</h2>
              {unscheduled.length > 0 && (
                <Badge variant="secondary" className="text-xs h-5 px-1.5">{unscheduled.length}</Badge>
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
                  <div key={task.id} className="bg-white border border-gray-200 rounded-lg p-3 hover:shadow-sm transition-shadow">
                    <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
                      <Badge className={`text-xs py-0 ${TYPE_COLORS[task.type as TaskType]}`}>{TYPE_LABELS[task.type as TaskType]}</Badge>
                      <Badge className={`text-xs py-0 ${PRIORITY_COLORS[task.priority as TaskPriority]}`}>{PRIORITY_LABELS[task.priority as TaskPriority]}</Badge>
                      <Badge className={`text-xs py-0 ${STATUS_COLORS[task.status as TaskStatus]}`}>{STATUS_LABELS[task.status as TaskStatus]}</Badge>
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
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* DAY / HOUR VIEW                                                   */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      {viewMode === 'day' && (
        <div>
          {/* Day navigation */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={prevDay}><ChevronLeft size={14} /></Button>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={nextDay}><ChevronRight size={14} /></Button>
              <input
                type="date" value={dayViewDate}
                onChange={e => setDayViewDate(e.target.value)}
                className="ml-1 text-sm border border-gray-200 rounded-md px-2 py-1 text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-700 capitalize">{fmtDateLong(dayViewDate)}</span>
              {dayViewDate === today && <Badge variant="secondary" className="text-xs">Hoy</Badge>}
            </div>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="h-7 text-xs px-2.5" onClick={goToToday}>Hoy</Button>
              {canEditMarketing && (
                <Button size="sm" className="h-7 text-xs px-2.5 bg-purple-600 hover:bg-purple-700 text-white"
                  onClick={() => openAddMarketing(dayViewDate)}>
                  <Plus size={12} className="mr-1" /> Agregar marketing
                </Button>
              )}
            </div>
          </div>

          {/* Hourly timeline */}
          <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">

            {/* All-day entries (hour === null) */}
            {dayViewMkt.filter(e => e.hour === null).length > 0 && (
              <div className="flex border-b border-gray-100">
                <div className="w-16 shrink-0 bg-gray-50 border-r border-gray-100 flex items-center justify-center py-3">
                  <span className="text-[10px] text-gray-400 font-medium [writing-mode:vertical-lr] rotate-180">Todo el día</span>
                </div>
                <div className="flex-1 p-2.5 flex flex-wrap gap-2">
                  {dayViewMkt.filter(e => e.hour === null).map(entry => (
                    <MktCard key={entry.id} entry={entry} canEdit={canEditMarketing}
                      onEdit={() => openEditMarketing(entry)} onDelete={() => handleDeleteMkt(entry.id)} compact />
                  ))}
                </div>
              </div>
            )}

            {/* Hour slots 0-23 */}
            {HOUR_LABELS.map((label, hour) => {
              const hourEntries    = dayViewMkt.filter(e => e.hour === hour)
              const isCurrentHour  = dayViewDate === today && new Date().getHours() === hour
              return (
                <div key={hour} className={[
                  'flex border-b border-gray-100 last:border-b-0 group',
                  isCurrentHour ? 'bg-blue-50/30' : 'hover:bg-gray-50/30',
                ].join(' ')}>
                  {/* Hour label */}
                  <div className={[
                    'w-16 shrink-0 border-r border-gray-100 flex items-start justify-end pr-3 pt-3 pb-2',
                    isCurrentHour ? 'bg-blue-50' : 'bg-gray-50/40',
                  ].join(' ')}>
                    <span className={['text-[11px] font-medium tabular-nums',
                      isCurrentHour ? 'text-blue-600 font-bold' : 'text-gray-400'].join(' ')}>
                      {label}
                    </span>
                  </div>

                  {/* Content */}
                  <div className="flex-1 px-3 py-2 min-h-[56px]">
                    {hourEntries.length > 0 ? (
                      <div className="flex flex-col gap-2">
                        {hourEntries.map(entry => (
                          <MktCard key={entry.id} entry={entry} canEdit={canEditMarketing}
                            onEdit={() => openEditMarketing(entry)} onDelete={() => handleDeleteMkt(entry.id)} />
                        ))}
                      </div>
                    ) : canEditMarketing ? (
                      <button
                        onClick={() => openAddMarketing(dayViewDate, hour)}
                        className="w-full text-left text-[11px] text-transparent group-hover:text-gray-300 hover:!text-purple-400 transition-colors py-1"
                      >
                        + Agregar contenido de marketing
                      </button>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Day detail modal ─────────────────────────────────────────────── */}
      <Dialog open={!!selectedDay} onOpenChange={open => { if (!open) setSelectedDay(null) }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <CalendarDays size={16} className="text-blue-600 shrink-0" />
              {selectedDay ? fmtDateLong(selectedDay) : ''}
            </DialogTitle>
          </DialogHeader>

          {/* Marketing section */}
          {selectedDayMkt.length > 0 && (
            <div className="mb-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <Megaphone size={13} className="text-purple-500" />
                  <span className="text-xs font-semibold text-purple-700">Contenido de marketing</span>
                  <Badge className="text-xs py-0 bg-purple-100 text-purple-700 border-0">{selectedDayMkt.length}</Badge>
                </div>
                {canEditMarketing && selectedDay && (
                  <button
                    onClick={() => { setSelectedDay(null); openAddMarketing(selectedDay) }}
                    className="text-[11px] text-purple-500 hover:text-purple-700 flex items-center gap-0.5"
                  >
                    <Plus size={10} /> Agregar
                  </button>
                )}
              </div>
              <div className="space-y-2">
                {selectedDayMkt.map(entry => (
                  <MktCard key={entry.id} entry={entry} canEdit={canEditMarketing}
                    onEdit={() => { setSelectedDay(null); openEditMarketing(entry) }}
                    onDelete={() => handleDeleteMkt(entry.id)} />
                ))}
              </div>
              {selectedDayEntries.length > 0 && <hr className="mt-3 border-gray-100" />}
            </div>
          )}

          {/* Tasks section */}
          {selectedDayEntries.length === 0 && selectedDayMkt.length === 0 ? (
            <div className="py-10 text-center">
              <CalendarDays size={36} className="mx-auto mb-3 text-gray-200" />
              <p className="text-sm text-gray-400">No hay tareas ni contenido para este día</p>
              {canEditMarketing && selectedDay && (
                <button onClick={() => { setSelectedDay(null); openAddMarketing(selectedDay) }}
                  className="mt-3 text-xs text-purple-500 hover:text-purple-700 flex items-center gap-1 mx-auto">
                  <Plus size={12} /> Agregar contenido de marketing
                </button>
              )}
            </div>
          ) : selectedDayEntries.length > 0 && (
            <div className="space-y-2.5 pt-1">
              {selectedDayEntries.map(({ task, isDeadline, isStart }) => {
                const overdue = isOverdue(task.due_date, task.status)
                return (
                  <div key={`modal-${task.id}-${isDeadline ? 'd' : 's'}`}
                    className={['border rounded-lg p-3',
                      overdue ? 'border-red-200 bg-red-50/40' : 'border-gray-200 bg-white'].join(' ')}>
                    <div className="flex items-center gap-1.5 flex-wrap mb-2">
                      <Badge className={`text-xs py-0 ${TYPE_COLORS[task.type as TaskType]}`}>{TYPE_LABELS[task.type as TaskType]}</Badge>
                      <Badge className={`text-xs py-0 ${PRIORITY_COLORS[task.priority as TaskPriority]}`}>{PRIORITY_LABELS[task.priority as TaskPriority]}</Badge>
                      <Badge className={`text-xs py-0 ${STATUS_COLORS[task.status as TaskStatus]}`}>{STATUS_LABELS[task.status as TaskStatus]}</Badge>
                      {isDeadline && isStart  && <span className="text-[11px] text-blue-700 bg-blue-50 border border-blue-100 px-1.5 py-0.5 rounded font-medium">Inicio y vencimiento</span>}
                      {isDeadline && !isStart && <span className="text-[11px] text-orange-700 bg-orange-50 border border-orange-100 px-1.5 py-0.5 rounded font-medium">⚑ Fecha límite</span>}
                      {!isDeadline && isStart && <span className="text-[11px] text-gray-600 bg-gray-100 border border-gray-200 px-1.5 py-0.5 rounded font-medium">▶ Inicio programado</span>}
                      {overdue && <span className="flex items-center gap-0.5 text-[11px] text-red-600 font-medium"><AlertTriangle size={10} /> Vencida</span>}
                    </div>
                    <p className="font-semibold text-gray-900 text-sm leading-snug">{task.title}</p>
                    <div className="flex flex-col gap-0.5 mt-2 text-xs text-gray-500">
                      {task.due_date     && <span className={`flex items-center gap-1 ${overdue ? 'text-red-600 font-medium' : ''}`}><Calendar size={10} /> Vence: {fmtDate(task.due_date)}</span>}
                      {task.scheduled_at && <span className="flex items-center gap-1"><Clock size={10} /> Inicio: {fmtDate(task.scheduled_at)}</span>}
                      {task.assignees.length > 0 && <span className="text-gray-400">Asignado a: {task.assignees.map(a => a.name || a.email).join(', ')}</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Add/Edit marketing modal ─────────────────────────────────────── */}
      <Dialog open={showMktModal} onOpenChange={open => { if (!open) { setShowMktModal(false); setEditingMkt(null) } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Megaphone size={16} className="text-purple-600" />
              {editingMkt ? 'Editar contenido de marketing' : 'Nuevo contenido de marketing'}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3 pt-1">
            {/* Date + Hour */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-gray-600 mb-1 block">Fecha *</Label>
                <Input type="date" value={mktForm.date}
                  onChange={e => setMktForm(f => ({ ...f, date: e.target.value }))}
                  className="h-8 text-sm" />
              </div>
              <div>
                <Label className="text-xs text-gray-600 mb-1 block">Hora</Label>
                <Select value={mktForm.hour !== '' ? mktForm.hour : '__all'}
                  onValueChange={v => setMktForm(f => ({ ...f, hour: v === '__all' ? '' : v }))}>
                  <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all">Todo el día</SelectItem>
                    {HOUR_LABELS.map((label, i) => <SelectItem key={i} value={String(i)}>{label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Title */}
            <div>
              <Label className="text-xs text-gray-600 mb-1 block">Título *</Label>
              <Input placeholder="Ej: Campaña fin de semana"
                value={mktForm.title}
                onChange={e => setMktForm(f => ({ ...f, title: e.target.value }))}
                className="h-8 text-sm" />
            </div>

            {/* Consigna */}
            <div>
              <Label className="text-xs text-gray-600 mb-1 block">Consigna / Mensaje</Label>
              <Textarea placeholder="Texto a difundir, instrucciones para el equipo..."
                value={mktForm.consigna}
                onChange={e => setMktForm(f => ({ ...f, consigna: e.target.value }))}
                className="text-sm min-h-[80px] resize-none" />
            </div>

            {/* Image */}
            <div>
              <Label className="text-xs text-gray-600 mb-1 block">Imagen</Label>
              <div className="flex border border-gray-200 rounded-lg overflow-hidden mb-2 text-xs">
                <button onClick={() => setMktForm(f => ({ ...f, imageMode: 'url' }))}
                  className={['flex-1 py-1 font-medium transition-colors',
                    mktForm.imageMode === 'url' ? 'bg-purple-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'].join(' ')}>
                  URL
                </button>
                <button onClick={() => setMktForm(f => ({ ...f, imageMode: 'upload' }))}
                  className={['flex-1 py-1 font-medium transition-colors',
                    mktForm.imageMode === 'upload' ? 'bg-purple-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'].join(' ')}>
                  Subir archivo
                </button>
              </div>

              {mktForm.imageMode === 'url' ? (
                <Input placeholder="https://ejemplo.com/imagen.jpg"
                  value={mktForm.imageUrl}
                  onChange={e => setMktForm(f => ({ ...f, imageUrl: e.target.value, imagePreview: e.target.value }))}
                  className="h-8 text-sm" />
              ) : (
                <>
                  <input ref={fileRef} type="file" accept="image/*" onChange={handleImageFile} className="hidden" />
                  <Button type="button" variant="outline" size="sm" className="w-full h-8 text-xs"
                    onClick={() => fileRef.current?.click()}>
                    <ImageIcon size={12} className="mr-1.5" /> Seleccionar imagen (máx. 3 MB)
                  </Button>
                  <p className="text-[10px] text-gray-400 mt-1">
                    Se almacena como base64. Para producción, recomendamos subir a un CDN y usar URL.
                  </p>
                </>
              )}

              {/* Preview */}
              {(mktForm.imageMode === 'url' ? mktForm.imageUrl : mktForm.imagePreview) && (
                <div className="mt-2 rounded-lg overflow-hidden border border-gray-200 bg-gray-50 h-28 flex items-center justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={mktForm.imageMode === 'url' ? mktForm.imageUrl : mktForm.imagePreview}
                    alt="Preview"
                    className="max-h-full max-w-full object-contain"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                </div>
              )}
            </div>

            {mktError && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded px-2.5 py-1.5">
                {mktError}
              </p>
            )}

            <div className="flex gap-2 pt-1">
              <Button variant="outline" size="sm" className="flex-1 h-8 text-xs"
                onClick={() => { setShowMktModal(false); setEditingMkt(null) }}>
                Cancelar
              </Button>
              <Button size="sm" className="flex-1 h-8 text-xs bg-purple-600 hover:bg-purple-700 text-white"
                onClick={handleSaveMkt} disabled={savingMkt}>
                {savingMkt ? 'Guardando...' : editingMkt ? 'Guardar cambios' : 'Crear entrada'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── MktCard — subcomponente de tarjeta de marketing ───────────────────────────

function MktCard({
  entry, canEdit, onEdit, onDelete, compact = false,
}: {
  entry: MarketingEntry
  canEdit: boolean
  onEdit: () => void
  onDelete: () => void
  compact?: boolean
}) {
  return (
    <div className="border border-purple-100 bg-purple-50/40 rounded-lg p-2.5 group/card relative">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <Megaphone size={11} className="text-purple-500 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-purple-900 leading-snug truncate">{entry.title}</p>
            {entry.hour !== null && (
              <span className="text-[10px] text-purple-400 flex items-center gap-0.5">
                <Clock size={8} /> {HOUR_LABELS[entry.hour]}
              </span>
            )}
          </div>
        </div>
        {canEdit && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover/card:opacity-100 transition-opacity shrink-0">
            <button onClick={onEdit}
              className="p-1 rounded hover:bg-purple-100 text-purple-400 hover:text-purple-600">
              <Pencil size={10} />
            </button>
            <button onClick={onDelete}
              className="p-1 rounded hover:bg-red-100 text-gray-400 hover:text-red-500">
              <Trash2 size={10} />
            </button>
          </div>
        )}
      </div>

      {entry.consigna && !compact && (
        <p className="text-[11px] text-gray-600 mt-1.5 leading-relaxed line-clamp-3 whitespace-pre-wrap">
          {entry.consigna}
        </p>
      )}

      {entry.image_url && !compact && (
        <div className="mt-2 rounded-md overflow-hidden bg-gray-100 max-h-48">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={entry.image_url} alt={entry.title}
            className="w-full object-cover"
            onError={e => { (e.target as HTMLImageElement).parentElement!.style.display = 'none' }} />
        </div>
      )}

      {entry.image_url && compact && (
        <span className="text-[10px] text-purple-400 flex items-center gap-0.5 mt-0.5">
          <ImageIcon size={8} /> imagen adjunta
        </span>
      )}

      {entry.creator_name && !compact && (
        <p className="text-[10px] text-gray-400 mt-1.5">Por: {entry.creator_name}</p>
      )}
    </div>
  )
}
