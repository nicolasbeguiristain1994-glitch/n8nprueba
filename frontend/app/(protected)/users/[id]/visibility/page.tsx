'use client'

/**
 * /users/[id]/visibility
 *
 * Panel de gestión de visibilidad de contactos para un operador.
 * Solo accesible por admin.
 *
 * Layout: dual-panel
 *   Izquierda → contactos disponibles (no asignados), con búsqueda y filtros
 *   Derecha   → contactos asignados al operador
 *
 * Acciones:
 *   - Asignar seleccionados
 *   - Asignar todos (con filtro activo)
 *   - Quitar seleccionados
 *   - Quitar todos
 */

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, ArrowRight, ArrowLeft as ArrowLeftIcon, Search, Users, UserCheck, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { fetchJson } from '@/lib/fetchJson'

// ── Types ─────────────────────────────────────────────────────────────────────

type ContactRow = {
  id: string
  phone_number: string
  first_name: string | null
  last_name: string | null
  segment: string | null
  panel: string | null
  linea: number | null
}

type OperatorUser = {
  id: string
  name: string | null
  email: string
  role: string
}

const PANEL_OPTIONS = ['betcoin', 'bigwin', 'farabet', 'ofizeus', 'royal']
const SEGMENT_LABEL: Record<string, string> = { bajo: 'Bajo', medio: 'Medio', vip: 'Vip', super_vip: 'Super Vip' }

// ── Sub-component: contact card ───────────────────────────────────────────────

function ContactCard({
  contact,
  selected,
  onToggle,
}: {
  contact: ContactRow
  selected: boolean
  onToggle: (id: string) => void
}) {
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || '—'
  return (
    <label
      className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors border
        ${selected ? 'bg-green-50 border-green-300' : 'bg-white border-gray-100 hover:bg-gray-50'}`}
    >
      <input
        type="checkbox"
        className="rounded"
        checked={selected}
        onChange={() => onToggle(contact.id)}
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{name}</p>
        <p className="text-xs text-gray-400 font-mono">{contact.phone_number}</p>
      </div>
      <div className="flex gap-1 flex-wrap justify-end">
        {contact.panel && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700">{contact.panel}</span>
        )}
        {contact.segment && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-50 text-yellow-700">
            {SEGMENT_LABEL[contact.segment] ?? contact.segment}
          </span>
        )}
        {contact.linea && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-50 text-orange-700">L{contact.linea}</span>
        )}
      </div>
    </label>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function VisibilityPage() {
  const { id: operatorId } = useParams<{ id: string }>()
  const router = useRouter()

  const [operator, setOperator]         = useState<OperatorUser | null>(null)
  const [available, setAvailable]       = useState<ContactRow[]>([])
  const [assigned, setAssigned]         = useState<ContactRow[]>([])
  const [availTotal, setAvailTotal]     = useState(0)
  const [assignedTotal, setAssignedTotal] = useState(0)
  const [availPage, setAvailPage]       = useState(1)
  const [assignedPage, setAssignedPage] = useState(1)
  const [selectedAvail, setSelectedAvail]       = useState<Set<string>>(new Set())
  const [selectedAssigned, setSelectedAssigned] = useState<Set<string>>(new Set())
  const [loadingAvail, setLoadingAvail]   = useState(false)
  const [loadingAssigned, setLoadingAssigned] = useState(false)
  const [working, setWorking]             = useState(false)
  const [error, setError]                 = useState<string | null>(null)

  // Filtros panel disponibles
  const [searchAvail, setSearchAvail]   = useState('')
  const [filterPanel, setFilterPanel]   = useState('')
  const [filterSegment, setFilterSegment] = useState('')
  const [searchAssigned, setSearchAssigned] = useState('')

  // Cargar datos del operador
  useEffect(() => {
    fetchJson<{ users: OperatorUser[] }>('/api/users')
      .then(d => {
        const u = d.users?.find((u: OperatorUser) => u.id === operatorId)
        if (u) setOperator(u)
      })
      .catch(() => {})
  }, [operatorId])

  const loadAvailable = useCallback(() => {
    setLoadingAvail(true)
    const q = new URLSearchParams({
      q: searchAvail, panel: filterPanel, segment: filterSegment,
      page: String(availPage),
    })
    fetchJson<{ contacts: ContactRow[]; total: number }>(
      `/api/users/${operatorId}/visibility/available?${q}`
    )
      .then(d => { setAvailable(d.contacts || []); setAvailTotal(d.total || 0) })
      .catch(() => setAvailable([]))
      .finally(() => setLoadingAvail(false))
  }, [operatorId, searchAvail, filterPanel, filterSegment, availPage])

  const loadAssigned = useCallback(() => {
    setLoadingAssigned(true)
    const q = new URLSearchParams({ q: searchAssigned, page: String(assignedPage) })
    fetchJson<{ contacts: ContactRow[]; total: number }>(
      `/api/users/${operatorId}/visibility?${q}`
    )
      .then(d => { setAssigned(d.contacts || []); setAssignedTotal(d.total || 0) })
      .catch(() => setAssigned([]))
      .finally(() => setLoadingAssigned(false))
  }, [operatorId, searchAssigned, assignedPage])

  useEffect(() => { loadAvailable() }, [loadAvailable])
  useEffect(() => { loadAssigned() },  [loadAssigned])

  // ── Acciones ────────────────────────────────────────────────────────────────

  const doAssign = async (ids: string[], all = false, filter?: object) => {
    setWorking(true); setError(null)
    const res = await fetch(`/api/users/${operatorId}/visibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(all ? { all: true, filter } : { contact_ids: ids }),
    })
    setWorking(false)
    if (!res.ok) { setError((await res.json()).error || 'Error al asignar'); return }
    setSelectedAvail(new Set())
    loadAvailable(); loadAssigned()
  }

  const doUnassign = async (ids: string[], all = false) => {
    setWorking(true); setError(null)
    const res = await fetch(`/api/users/${operatorId}/visibility`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(all ? { all: true } : { contact_ids: ids }),
    })
    setWorking(false)
    if (!res.ok) { setError((await res.json()).error || 'Error al quitar'); return }
    setSelectedAssigned(new Set())
    loadAvailable(); loadAssigned()
  }

  const toggleAvail    = (id: string) => setSelectedAvail(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleAssigned = (id: string) => setSelectedAssigned(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.push('/users')}>
          <ArrowLeftIcon size={14} className="mr-1" /> Usuarios
        </Button>
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <UserCheck size={18} className="text-indigo-600" />
            Visibilidad de contactos
          </h1>
          {operator && (
            <p className="text-sm text-gray-500">
              {operator.name ?? operator.email}
              <Badge variant="outline" className="ml-2 text-xs">{operator.role}</Badge>
              <span className="ml-2 text-gray-400">{assignedTotal.toLocaleString()} asignados</span>
            </p>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2 text-sm text-red-600 flex items-center justify-between">
          {error}
          <button onClick={() => setError(null)} className="ml-4 text-red-400 hover:text-red-600">✕</button>
        </div>
      )}

      {/* Dual panel */}
      <div className="grid grid-cols-2 gap-4">

        {/* ── Panel izquierdo: disponibles ─────────────────────────────────── */}
        <div className="border border-gray-200 rounded-xl overflow-hidden flex flex-col">
          <div className="bg-gray-50 px-4 py-3 border-b border-gray-200">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
                <Users size={14} /> Disponibles
                <span className="text-gray-400 font-normal">({availTotal.toLocaleString()})</span>
              </span>
              <Button variant="ghost" size="sm" onClick={loadAvailable} disabled={loadingAvail}>
                <RefreshCw size={12} className={loadingAvail ? 'animate-spin' : ''} />
              </Button>
            </div>
            <div className="space-y-1.5">
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <Input className="pl-8 h-8 text-sm" placeholder="Buscar…"
                  value={searchAvail} onChange={e => { setSearchAvail(e.target.value); setAvailPage(1) }} />
              </div>
              <div className="flex gap-1.5">
                <Select value={filterPanel || 'all'} onValueChange={v => { setFilterPanel(v === 'all' || !v ? '' : v); setAvailPage(1) }}>
                  <SelectTrigger className="h-7 text-xs flex-1"><SelectValue placeholder="Agente" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos los agentes</SelectItem>
                    {PANEL_OPTIONS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={filterSegment || 'all'} onValueChange={v => { setFilterSegment(v === 'all' || !v ? '' : v); setAvailPage(1) }}>
                  <SelectTrigger className="h-7 text-xs flex-1"><SelectValue placeholder="Nivel" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos los niveles</SelectItem>
                    <SelectItem value="super_vip">Super Vip</SelectItem>
                    <SelectItem value="vip">Vip</SelectItem>
                    <SelectItem value="medio">Medio</SelectItem>
                    <SelectItem value="bajo">Bajo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Lista */}
          <div className="flex-1 overflow-y-auto max-h-[420px] p-2 space-y-1">
            {loadingAvail
              ? <p className="text-center text-sm text-gray-400 py-8">Cargando…</p>
              : available.length === 0
                ? <p className="text-center text-sm text-gray-400 py-8">Sin contactos disponibles</p>
                : available.map(c => (
                  <ContactCard key={c.id} contact={c} selected={selectedAvail.has(c.id)} onToggle={toggleAvail} />
                ))
            }
          </div>

          {/* Paginación disponibles */}
          {availTotal > 50 && (
            <div className="border-t border-gray-100 px-3 py-2 flex justify-between items-center text-xs text-gray-400">
              <button disabled={availPage === 1} onClick={() => setAvailPage(p => p - 1)}
                className="disabled:opacity-40 hover:text-gray-600">← Ant</button>
              <span>Pág. {availPage} / {Math.ceil(availTotal / 50)}</span>
              <button disabled={availPage * 50 >= availTotal} onClick={() => setAvailPage(p => p + 1)}
                className="disabled:opacity-40 hover:text-gray-600">Sig →</button>
            </div>
          )}

          {/* Acciones disponibles */}
          <div className="border-t border-gray-200 px-3 py-2 flex gap-2 flex-wrap bg-gray-50">
            <Button size="sm" disabled={selectedAvail.size === 0 || working}
              onClick={() => doAssign(Array.from(selectedAvail))}
              className="bg-green-600 hover:bg-green-700 text-white text-xs gap-1">
              Asignar {selectedAvail.size > 0 ? `(${selectedAvail.size})` : 'sel.'} <ArrowRight size={12} />
            </Button>
            <Button size="sm" variant="outline" disabled={working}
              onClick={() => doAssign([], true, {
                panel: filterPanel || undefined,
                segment: filterSegment || undefined,
              })}
              className="text-xs border-green-200 text-green-700 hover:bg-green-50">
              Asignar todos{filterPanel || filterSegment ? ' (filtro)' : ''}
            </Button>
          </div>
        </div>

        {/* ── Panel derecho: asignados ──────────────────────────────────────── */}
        <div className="border border-gray-200 rounded-xl overflow-hidden flex flex-col">
          <div className="bg-gray-50 px-4 py-3 border-b border-gray-200">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
                <UserCheck size={14} className="text-green-600" /> Asignados
                <span className="text-gray-400 font-normal">({assignedTotal.toLocaleString()})</span>
              </span>
              <Button variant="ghost" size="sm" onClick={loadAssigned} disabled={loadingAssigned}>
                <RefreshCw size={12} className={loadingAssigned ? 'animate-spin' : ''} />
              </Button>
            </div>
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input className="pl-8 h-8 text-sm" placeholder="Buscar asignados…"
                value={searchAssigned} onChange={e => { setSearchAssigned(e.target.value); setAssignedPage(1) }} />
            </div>
          </div>

          {/* Lista */}
          <div className="flex-1 overflow-y-auto max-h-[420px] p-2 space-y-1">
            {loadingAssigned
              ? <p className="text-center text-sm text-gray-400 py-8">Cargando…</p>
              : assigned.length === 0
                ? <p className="text-center text-sm text-gray-400 py-8">Sin contactos asignados</p>
                : assigned.map(c => (
                  <ContactCard key={c.id} contact={c} selected={selectedAssigned.has(c.id)} onToggle={toggleAssigned} />
                ))
            }
          </div>

          {/* Paginación asignados */}
          {assignedTotal > 50 && (
            <div className="border-t border-gray-100 px-3 py-2 flex justify-between items-center text-xs text-gray-400">
              <button disabled={assignedPage === 1} onClick={() => setAssignedPage(p => p - 1)}
                className="disabled:opacity-40 hover:text-gray-600">← Ant</button>
              <span>Pág. {assignedPage} / {Math.ceil(assignedTotal / 50)}</span>
              <button disabled={assignedPage * 50 >= assignedTotal} onClick={() => setAssignedPage(p => p + 1)}
                className="disabled:opacity-40 hover:text-gray-600">Sig →</button>
            </div>
          )}

          {/* Acciones asignados */}
          <div className="border-t border-gray-200 px-3 py-2 flex gap-2 flex-wrap bg-gray-50">
            <Button size="sm" disabled={selectedAssigned.size === 0 || working}
              onClick={() => doUnassign(Array.from(selectedAssigned))}
              variant="outline"
              className="text-xs border-red-200 text-red-600 hover:bg-red-50 gap-1">
              <ArrowLeft size={12} /> Quitar {selectedAssigned.size > 0 ? `(${selectedAssigned.size})` : 'sel.'}
            </Button>
            <Button size="sm" variant="outline" disabled={working || assignedTotal === 0}
              onClick={() => { if (confirm(`¿Quitar los ${assignedTotal} contactos asignados?`)) doUnassign([], true) }}
              className="text-xs border-red-200 text-red-600 hover:bg-red-50 gap-1">
              <Trash2 size={12} /> Quitar todos
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
