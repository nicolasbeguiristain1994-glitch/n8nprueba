'use client'
import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import * as XLSX from 'xlsx'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Search, Upload, RefreshCw, List, CheckSquare, X, Users, UserPlus,
  Trash2, Download, DatabaseZap, Pencil,
} from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { PageHeader } from '@/components/layout/PageHeader'
import {
  DataTable,
  DataTableColumnHeader,
  DataTableBulkActions,
  DataTableActionButton,
  DataTableRowActions,
  DataTableEmptyState,
  EditableCell,
} from '@/components/data-display/DataTable'
import type { ColumnDef, RowSelectionState, PaginationState } from '@/components/data-display/DataTable'

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

interface Contact {
  id: string; phone_number: string; first_name: string; last_name: string
  email: string; status: string; opt_in: boolean; created_at: string; segment: string; panel: string; gaming: string; linea: number | null
  actividad?: string; valor_riesgo?: string; antiguedad?: string
}
interface ImportRow   { phone: string; name?: string; segment?: string }
interface ContactList { id: string; name: string; contact_count: number; created_at: string }

// ─────────────────────────────────────────────────────────────────────────────
// Constantes de dominio
// ─────────────────────────────────────────────────────────────────────────────

const PANEL_OPTIONS = ['betcoin', 'bigwin', 'farabet', 'ofizeus', 'royal']

const NIVEL_LABEL: Record<string, string> = {
  bajo: 'Bajo', medio: 'Medio', alto: 'Vip', vip: 'Super Vip',
}

const SEGMENT_STYLE: Record<string, string> = {
  casual: 'bg-gray-100 text-gray-600', regular: 'bg-blue-100 text-blue-700',
  vip: 'bg-purple-100 text-purple-700', whale: 'bg-amber-100 text-amber-700',
  bajo: 'bg-orange-50 text-orange-700', medio: 'bg-slate-100 text-slate-600',
  alto: 'bg-yellow-100 text-yellow-700',
}
const ACTIVIDAD_STYLE: Record<string, string> = {
  frecuente: 'bg-green-100 text-green-700', regular: 'bg-blue-100 text-blue-700',
  ocasional: 'bg-gray-100 text-gray-600', nuevo: 'bg-cyan-100 text-cyan-700',
  en_riesgo: 'bg-orange-100 text-orange-700', inactivo: 'bg-red-100 text-red-600',
  perdido: 'bg-zinc-800 text-white',
}
const VALOR_RIESGO_STYLE: Record<string, string> = {
  critico: 'bg-red-100 text-red-700', medio: 'bg-orange-100 text-orange-700',
  bajo: 'bg-yellow-100 text-yellow-700',
}
const ANTIGUEDAD_STYLE: Record<string, string> = {
  nuevo: 'bg-sky-100 text-sky-600', reciente: 'bg-blue-100 text-blue-600',
  establecido: 'bg-indigo-100 text-indigo-700', veterano: 'bg-violet-100 text-violet-700',
  leal: 'bg-purple-100 text-purple-700',
}
const GAMING_STYLE: Record<string, string> = {
  slots: 'bg-pink-100 text-pink-700', deportivas: 'bg-green-100 text-green-700',
  ambas: 'bg-cyan-100 text-cyan-700',
}

// ─────────────────────────────────────────────────────────────────────────────
// Página
// ─────────────────────────────────────────────────────────────────────────────

export default function Contacts() {
  // ── Datos ─────────────────────────────────────────────────────────────────
  const [contacts, setContacts] = useState<Contact[]>([])
  const [total, setTotal]       = useState(0)
  const [loading, setLoading]   = useState(false)

  // ── Filtros ───────────────────────────────────────────────────────────────
  const [search, setSearch]                   = useState('')
  const [segment, setSegment]                 = useState('')
  const [filterGaming, setFilterGaming]       = useState('')
  const [filterPanel, setFilterPanel]         = useState('')
  const [filterLinea, setFilterLinea]         = useState('')
  const [filterActividad, setFilterActividad] = useState('')
  const [filterAntiguedad, setFilterAntiguedad] = useState('')

  // ── Paginación (TanStack format) ──────────────────────────────────────────
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 50 })

  // ── Selección (TanStack format) ───────────────────────────────────────────
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const selectedIds   = Object.keys(rowSelection)
  const selectedCount = selectedIds.length

  // ── Listas ────────────────────────────────────────────────────────────────
  const [lists, setLists] = useState<ContactList[]>([])

  // ── Import modal ─────────────────────────────────────────────────────────
  const [showImport, setShowImport]     = useState(false)
  const [importRows, setImportRows]     = useState<ImportRow[]>([])
  const [importPanel, setImportPanel]   = useState('')
  const [importLinea, setImportLinea]   = useState('')
  const [importing, setImporting]       = useState(false)
  const [importResult, setImportResult] = useState<{ inserted: number; updated: number; skipped: number } | null>(null)
  const [importError, setImportError]   = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // ── Add contact modal ─────────────────────────────────────────────────────
  const [showAdd, setShowAdd]       = useState(false)
  const [newPhone, setNewPhone]     = useState('')
  const [newName, setNewName]       = useState('')
  const [newPanel, setNewPanel]     = useState('')
  const [newGaming, setNewGaming]   = useState('')
  const [newSegment, setNewSegment] = useState('')
  const [newLinea, setNewLinea]     = useState('')
  const [addError, setAddError]     = useState('')
  const [addSaving, setAddSaving]   = useState(false)

  // ── List modal ────────────────────────────────────────────────────────────
  const [showList, setShowList]               = useState(false)
  const [listMode, setListMode]               = useState<'selection' | 'criteria'>('selection')
  const [newListName, setNewListName]         = useState('')
  const [savingList, setSavingList]           = useState(false)
  const [listError, setListError]             = useState<string | null>(null)
  const [criteriaPanel, setCriteriaPanel]     = useState('')
  const [criteriaGaming, setCriteriaGaming]   = useState('')
  const [criteriaSegment, setCriteriaSegment] = useState('')
  const [criteriaActividad, setCriteriaActividad]   = useState('')
  const [criteriaAntiguedad, setCriteriaAntiguedad] = useState('')

  // ── Edit contact modal ────────────────────────────────────────────────────
  const [editContact, setEditContact]   = useState<Contact | null>(null)
  const [editFirstName, setEditFirstName] = useState('')
  const [editLastName, setEditLastName]   = useState('')
  const [editPanel, setEditPanel]         = useState('')
  const [editLinea, setEditLinea]         = useState('')
  const [editSegment, setEditSegment]     = useState('')
  const [editGaming, setEditGaming]       = useState('')
  const [editSaving, setEditSaving]       = useState(false)
  const [editError, setEditError]         = useState<string | null>(null)

  // ── Misc ──────────────────────────────────────────────────────────────────
  const [updateError, setUpdateError]           = useState<string | null>(null)
  const [downloading, setDownloading]           = useState(false)
  const [selectingAll, setSelectingAll]         = useState(false)
  const [repopulating, setRepopulating]         = useState(false)
  const [repopulateResult, setRepopulateResult] = useState<{ total_lists: number; lists: Array<{ nombre: string; members: number; created: boolean }> } | null>(null)
  const [repopulateError, setRepopulateError]   = useState<string | null>(null)

  const { user: currentUser } = useCurrentUser()

  // ── Carga de datos ────────────────────────────────────────────────────────

  const load = useCallback(() => {
    setLoading(true)
    const q = new URLSearchParams({
      q: search, page: String(pagination.pageIndex + 1),
      segment, gaming: filterGaming, panel: filterPanel.trim(),
      linea: filterLinea, actividad: filterActividad, antiguedad: filterAntiguedad,
    })
    fetchJson<{ contacts: Contact[]; total: number }>(`/api/contacts?${q}`)
      .then(d => { setContacts(d.contacts || []); setTotal(d.total || 0) })
      .catch(() => { setContacts([]); setTotal(0) })
      .finally(() => setLoading(false))
  }, [search, pagination.pageIndex, segment, filterGaming, filterPanel, filterLinea, filterActividad, filterAntiguedad])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    fetchJson<{ lists: ContactList[] }>('/api/lists')
      .then(d => setLists(d.lists || []))
      .catch(() => setLists([]))
  }, [])

  // Resetear página al cambiar filtros
  const resetPage = useCallback(() => setPagination(p => ({ ...p, pageIndex: 0 })), [])

  // ── Inline edits ──────────────────────────────────────────────────────────

  const updateField = useCallback(async (
    contactId: string,
    field: keyof Contact,
    value: string | number | null,
  ) => {
    const old = contacts.find(c => c.id === contactId)?.[field]
    setContacts(cs => cs.map(c => c.id === contactId ? { ...c, [field]: value } : c))
    const res = await fetch(`/api/contacts/${contactId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    })
    if (!res.ok) {
      setContacts(cs => cs.map(c => c.id === contactId ? { ...c, [field]: old } : c))
      setUpdateError(`Error al actualizar ${field}`)
    }
  }, [contacts])

  // ── CRUD ──────────────────────────────────────────────────────────────────

  const addContact = async () => {
    if (!newPhone.trim()) { setAddError('El teléfono es obligatorio'); return }
    setAddSaving(true); setAddError('')
    const res = await fetch('/api/contacts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: newPhone, name: newName, panel: newPanel, gaming: newGaming || null, segment: newSegment || null, linea: newLinea ? Number(newLinea) : null }),
    })
    const data = await res.json()
    setAddSaving(false)
    if (!res.ok) { setAddError(data.error || 'Error al guardar'); return }
    setShowAdd(false); setNewPhone(''); setNewName(''); setNewPanel('')
    setNewGaming(''); setNewSegment(''); setNewLinea(''); setAddError('')
    load()
  }

  const deleteContact = useCallback(async (id: string) => {
    if (!confirm('¿Eliminar este contacto?')) return
    const res = await fetch(`/api/contacts/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      alert(`Error al eliminar: ${data.error || res.statusText}`)
      return
    }
    setContacts(prev => prev.filter(c => c.id !== id))
    setTotal(prev => prev - 1)
    setRowSelection(prev => { const n = { ...prev }; delete n[id]; return n })
  }, [])

  const deleteSelected = async () => {
    if (!confirm(`¿Eliminar ${selectedCount} contactos seleccionados?`)) return
    const responses = await Promise.all(
      selectedIds.map(id => fetch(`/api/contacts/${id}`, { method: 'DELETE' })
        .then(r => ({ id, ok: r.ok })).catch(() => ({ id, ok: false })))
    )
    const deleted = new Set(responses.filter(r => r.ok).map(r => r.id))
    if (deleted.size === 0) return
    setContacts(prev => prev.filter(c => !deleted.has(c.id)))
    setTotal(prev => prev - deleted.size)
    setRowSelection({})
  }

  const selectAllFiltered = async () => {
    setSelectingAll(true)
    try {
      const q = new URLSearchParams({
        q: search, segment, gaming: filterGaming, panel: filterPanel.trim(),
        linea: filterLinea, actividad: filterActividad, antiguedad: filterAntiguedad,
        select_all: 'true',
      })
      const d = await fetchJson<{ ids: string[] }>(`/api/contacts?${q}`)
      const next: RowSelectionState = {}
      for (const id of d.ids || []) next[id] = true
      setRowSelection(next)
    } catch { /* ignore */ }
    finally { setSelectingAll(false) }
  }

  // ── Import ────────────────────────────────────────────────────────────────

  const parseVcfText = (text: string): ImportRow[] => {
    const normalizePhone = (raw: string): string | null => {
      let p = raw.replace(/[-\s()]/g, '')
      if (!p.startsWith('+')) p = '+' + p
      if (!/^\+\d{7,15}$/.test(p)) return null
      return p
    }
    const rows: ImportRow[] = []
    const seen = new Set<string>()
    const cards = text.split('BEGIN:VCARD').filter(c => c.trim())
    for (const card of cards) {
      const fnMatch  = card.match(/^FN:(.+)$/m)
      const telLines = [...card.matchAll(/^TEL[^:]*:(.+)$/gm)]
      if (!fnMatch) continue
      const name = fnMatch[1].trim()
      let phone: string | null = null
      for (const tel of telLines) {
        const n = normalizePhone(tel[1].trim())
        if (n) { phone = n; break }
      }
      if (!phone || seen.has(phone)) continue
      seen.add(phone)
      rows.push({ phone, name })
    }
    return rows
  }

  const handleFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const data = e.target?.result
      let rows: ImportRow[] = []
      if (file.name.endsWith('.vcf')) {
        rows = parseVcfText(data as string)
      } else if (file.name.endsWith('.csv')) {
        const text = data as string
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
        const header = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/"/g, ''))
        const phoneIdx = header.findIndex(h => h.includes('phone') || h.includes('tel') || h.includes('celular') || h.includes('numero'))
        const nameIdx  = header.findIndex(h => h.includes('name') || h.includes('nombre'))
        const segIdx   = header.findIndex(h => h.includes('segment') || h.includes('grupo') || h.includes('tag'))
        rows = lines.slice(1).map(l => {
          const cols = l.split(',').map(c => c.trim().replace(/"/g, ''))
          return { phone: cols[phoneIdx] || '', name: cols[nameIdx] || undefined, segment: cols[segIdx] || undefined }
        }).filter(r => r.phone)
      } else {
        const wb = XLSX.read(data, { type: 'binary' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const json = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: '' })
        rows = json.map(row => {
          const phoneKey = Object.keys(row).find(k => k.toLowerCase().includes('phone') || k.toLowerCase().includes('tel') || k.toLowerCase().includes('celular') || k.toLowerCase().includes('numero')) || ''
          const nameKey  = Object.keys(row).find(k => k.toLowerCase().includes('name') || k.toLowerCase().includes('nombre')) || ''
          const segKey   = Object.keys(row).find(k => k.toLowerCase().includes('segment') || k.toLowerCase().includes('grupo')) || ''
          return { phone: String(row[phoneKey] || ''), name: row[nameKey] || undefined, segment: row[segKey] || undefined }
        }).filter(r => r.phone)
      }
      setImportRows(rows)
    }
    if (file.name.endsWith('.csv') || file.name.endsWith('.vcf')) reader.readAsText(file)
    else reader.readAsBinaryString(file)
  }

  const confirmImport = async () => {
    setImporting(true); setImportError(null)
    let res: Response
    try {
      res = await fetch('/api/contacts/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contacts: importRows, panel: importPanel || undefined, linea: importLinea ? Number(importLinea) : undefined }),
      })
    } catch { setImporting(false); setImportError('Error de red al importar'); return }
    const data = await res.json().catch(() => ({}))
    setImporting(false)
    if (!res.ok) { setImportError(data.error || 'Error al importar'); return }
    setImportResult(data); load()
  }

  // ── Export ────────────────────────────────────────────────────────────────

  const downloadContacts = async (format: 'csv' | 'xlsx') => {
    setDownloading(true)
    const q = new URLSearchParams({
      q: search, segment, gaming: filterGaming, panel: filterPanel.trim(),
      linea: filterLinea, actividad: filterActividad, antiguedad: filterAntiguedad, download: 'true',
    })
    const d = await fetch(`/api/contacts?${q}`).then(r => r.json())
    const rows: Contact[] = d.contacts || []
    const exportData = rows.map(c => ({
      'Teléfono': c.phone_number,
      'Nombre': [c.first_name, c.last_name].filter(Boolean).join(' ') || '',
      'Email': c.email || '', 'Agente': c.panel || '', 'Línea': c.linea ?? '',
      'Juego': c.gaming || '', 'Nivel': NIVEL_LABEL[c.segment] || c.segment || '',
      'Estado': c.actividad || c.status || '', 'Riesgo': c.valor_riesgo || '',
      'Antigüedad': c.antiguedad || '', 'Opt-in': c.opt_in ? 'sí' : 'no',
      'Fecha alta': c.created_at ? new Date(c.created_at).toLocaleDateString('es-AR') : '',
    }))
    const ws = XLSX.utils.json_to_sheet(exportData)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Contactos')
    ws['!cols'] = [14, 22, 24, 12, 8, 12, 10, 12, 12, 14, 10, 12].map(w => ({ wch: w }))
    const filterStr = [
      filterPanel && `panel-${filterPanel}`, filterGaming && `juego-${filterGaming}`,
      segment && `nivel-${segment}`, search && `busq-${search}`,
      filterActividad && `actividad-${filterActividad}`, filterAntiguedad && `antiguedad-${filterAntiguedad}`,
    ].filter(Boolean).join('_') || 'todos'
    const filename = `contactos_${filterStr}_${new Date().toISOString().slice(0, 10)}.${format}`
    if (format === 'csv') {
      const csv = XLSX.utils.sheet_to_csv(ws)
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
      URL.revokeObjectURL(url)
    } else {
      XLSX.writeFile(wb, filename)
    }
    setDownloading(false)
  }

  // ── Crear lista ───────────────────────────────────────────────────────────

  const createList = async () => {
    if (!newListName) return
    if (listMode === 'selection' && selectedCount === 0) return
    const hasCriteria = criteriaPanel || criteriaGaming || criteriaSegment || criteriaActividad || criteriaAntiguedad
    if (listMode === 'criteria' && !hasCriteria) return
    setSavingList(true); setListError(null)
    let body: object
    if (listMode === 'selection') {
      body = { name: newListName, contact_ids: selectedIds }
    } else {
      const tags: string[] = []
      if (criteriaActividad)  tags.push(`casino:actividad:${criteriaActividad}`)
      if (criteriaAntiguedad) tags.push(`casino:antiguedad:${criteriaAntiguedad}`)
      body = { name: newListName, criteria: { panel: criteriaPanel, gaming: criteriaGaming, segment: criteriaSegment, ...(tags.length ? { tags } : {}) } }
    }
    const res = await fetch('/api/lists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    setSavingList(false)
    if (!res.ok) { const d = await res.json().catch(() => ({})); setListError(d.error || 'Error al crear la lista'); return }
    setShowList(false); setNewListName(''); setRowSelection({})
    setCriteriaPanel(''); setCriteriaGaming(''); setCriteriaSegment(''); setCriteriaActividad(''); setCriteriaAntiguedad('')
    fetch('/api/lists').then(r => r.json()).then(d => setLists(d.lists || []))
  }

  const repopularListas = async () => {
    setRepopulating(true); setRepopulateError(null); setRepopulateResult(null)
    try {
      const res = await fetch('/api/lists/casino/repopulate', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setRepopulateError(data.error || 'Error al repoblar listas') }
      else { setRepopulateResult(data); fetch('/api/lists').then(r => r.json()).then(d => setLists(d.lists || [])) }
    } catch { setRepopulateError('Error de red') }
    finally { setRepopulating(false) }
  }

  const openEdit = useCallback((c: Contact) => {
    setEditContact(c)
    setEditFirstName(c.first_name || '')
    setEditLastName(c.last_name || '')
    setEditPanel(c.panel || '')
    setEditLinea(c.linea != null ? String(c.linea) : '')
    setEditSegment(c.segment || '')
    setEditGaming(c.gaming || '')
    setEditError(null)
  }, [])

  const saveEdit = async () => {
    if (!editContact) return
    setEditSaving(true); setEditError(null)
    const body: Record<string, unknown> = {
      first_name: editFirstName.trim() || null,
      last_name:  editLastName.trim()  || null,
      panel:      editPanel  || null,
      linea:      editLinea  ? Number(editLinea) : null,
      segment:    editSegment || null,
      gaming:     editGaming  || null,
    }
    try {
      const res = await fetch(`/api/contacts/${editContact.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setEditError(data.error || 'Error al guardar'); return }
      setEditContact(null)
      load()
    } catch {
      setEditError('Error de conexión')
    } finally {
      setEditSaving(false)
    }
  }

  // ── Columnas del DataTable ────────────────────────────────────────────────

  const columns = useMemo<ColumnDef<Contact, unknown>[]>(() => [
    {
      id: 'phone_number',
      accessorKey: 'phone_number',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Teléfono" />,
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.phone_number}</span>
      ),
      meta: { mobileLabel: 'Teléfono' },
    },
    {
      id: 'name',
      accessorFn: (row) => [row.first_name, row.last_name].filter(Boolean).join(' '),
      header: ({ column }) => <DataTableColumnHeader column={column} title="Nombre" />,
      cell: ({ getValue }) => (
        <span>{(getValue() as string) || '—'}</span>
      ),
      meta: { mobileLabel: 'Nombre' },
    },
    {
      id: 'panel',
      accessorKey: 'panel',
      header: 'Agente',
      enableSorting: false,
      cell: ({ row }) => (
        <EditableCell
          value={row.original.panel || ''}
          options={PANEL_OPTIONS.map(p => ({ value: p, label: p }))}
          activeClass="bg-indigo-50 text-indigo-700"
          placeholder="— sin agente"
          onChange={v => updateField(row.original.id, 'panel', v || null)}
        />
      ),
      meta: { mobileLabel: 'Agente' },
    },
    {
      id: 'linea',
      accessorKey: 'linea',
      header: 'Línea',
      enableSorting: false,
      cell: ({ row }) => (
        <EditableCell
          value={row.original.linea != null ? String(row.original.linea) : ''}
          options={Array.from({ length: 100 }, (_, i) => ({ value: String(i + 1), label: `Línea ${i + 1}` }))}
          activeClass="bg-orange-50 text-orange-700"
          placeholder="— sin línea"
          onChange={v => updateField(row.original.id, 'linea', v ? Number(v) : null)}
        />
      ),
      meta: { mobileLabel: 'Línea' },
    },
    {
      id: 'gaming',
      accessorKey: 'gaming',
      header: 'Juego',
      enableSorting: false,
      cell: ({ row }) => (
        <EditableCell
          value={row.original.gaming || ''}
          options={[
            { value: 'slots',      label: '🎰 Slots' },
            { value: 'deportivas', label: '⚽ Deportivas' },
            { value: 'ambas',      label: '🎯 Ambas' },
          ]}
          activeClass={GAMING_STYLE[row.original.gaming] ?? ''}
          placeholder="— sin asignar"
          onChange={v => updateField(row.original.id, 'gaming', v || null)}
        />
      ),
      meta: { mobileLabel: 'Juego' },
    },
    {
      id: 'segment',
      accessorKey: 'segment',
      header: 'Nivel',
      enableSorting: false,
      cell: ({ row }) => (
        <EditableCell
          value={row.original.segment || ''}
          options={[
            { value: 'vip',  label: 'Super Vip' },
            { value: 'alto', label: 'Vip' },
            { value: 'medio',label: 'Medio' },
            { value: 'bajo', label: 'Bajo' },
          ]}
          activeClass={SEGMENT_STYLE[row.original.segment] ?? 'bg-gray-100 text-gray-600'}
          placeholder="— sin nivel"
          onChange={v => updateField(row.original.id, 'segment', v || null)}
        />
      ),
      meta: { mobileLabel: 'Nivel' },
    },
    {
      id: 'casino',
      header: 'Casino',
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex flex-col gap-0.5">
          {row.original.valor_riesgo && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap ${VALOR_RIESGO_STYLE[row.original.valor_riesgo] ?? 'bg-gray-100 text-gray-600'}`}>
              ⚠ {row.original.valor_riesgo}
            </span>
          )}
          {row.original.antiguedad && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap ${ANTIGUEDAD_STYLE[row.original.antiguedad] ?? 'bg-gray-100 text-gray-600'}`}>
              {row.original.antiguedad}
            </span>
          )}
          {!row.original.valor_riesgo && !row.original.antiguedad && (
            <span className="text-muted-foreground/40 text-xs">—</span>
          )}
        </div>
      ),
      meta: { mobileLabel: 'Casino' },
    },
    {
      id: 'estado',
      header: 'Estado',
      enableSorting: false,
      cell: ({ row }) => row.original.actividad ? (
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${ACTIVIDAD_STYLE[row.original.actividad] ?? 'bg-gray-100 text-gray-600'}`}>
          {row.original.actividad}
        </span>
      ) : (
        <Badge variant={row.original.status === 'active' ? 'default' : 'secondary'}
               className={`text-xs ${row.original.status === 'active' ? 'bg-green-100 text-green-700' : ''}`}>
          {row.original.status}
        </Badge>
      ),
      meta: { mobileLabel: 'Estado' },
    },
    {
      id: 'opt_in',
      accessorKey: 'opt_in',
      header: 'Opt-in',
      enableSorting: false,
      cell: ({ row }) => (
        <span className={`text-xs font-medium ${row.original.opt_in ? 'text-green-600' : 'text-muted-foreground/50'}`}>
          {row.original.opt_in ? '✓' : '✗'}
        </span>
      ),
      meta: { mobileLabel: 'Opt-in' },
    },
    {
      id: 'created_at',
      accessorKey: 'created_at',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Alta" />,
      cell: ({ row }) => (
        <span className="text-muted-foreground text-xs">
          {new Date(row.original.created_at).toLocaleDateString('es-AR')}
        </span>
      ),
      meta: { mobileLabel: 'Alta' },
    },
    {
      id: 'actions',
      enableSorting: false,
      enableHiding: false,
      size: 40,
      cell: ({ row }) => (
        <DataTableRowActions>
          <DataTableActionButton
            onClick={() => openEdit(row.original)}
            icon={Pencil}
            label="Editar contacto"
          />
          <DataTableActionButton
            onClick={() => deleteContact(row.original.id)}
            icon={Trash2}
            label="Eliminar contacto"
            variant="destructive"
          />
        </DataTableRowActions>
      ),
    },
  ], [updateField, deleteContact])

  // ── JSX ───────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      <PageHeader
        title="Contactos"
        count={total}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </Button>

            {currentUser?.can_download_contacts && (
              <div className="relative group">
                <Button variant="outline" size="sm" disabled={downloading} className="border-teal-200 text-teal-700 hover:bg-teal-50">
                  <Download size={14} className={`mr-1 ${downloading ? 'animate-bounce' : ''}`} />
                  {downloading ? 'Descargando…' : 'Descargar'}
                </Button>
                <div className="absolute right-0 top-full mt-1 bg-popover border border-border rounded-lg shadow-lg z-20 hidden group-hover:block min-w-36">
                  <button onClick={() => downloadContacts('xlsx')} className="w-full text-left px-4 py-2 text-sm hover:bg-muted flex items-center gap-2 rounded-t-lg">
                    <span className="text-green-600 font-bold text-xs">XLS</span> Excel (.xlsx)
                  </button>
                  <button onClick={() => downloadContacts('csv')} className="w-full text-left px-4 py-2 text-sm hover:bg-muted flex items-center gap-2 rounded-b-lg border-t border-border">
                    <span className="text-blue-600 font-bold text-xs">CSV</span> CSV (.csv)
                  </button>
                </div>
              </div>
            )}

            <Button size="sm" variant="outline" onClick={selectAllFiltered} disabled={selectingAll}
              className="border-blue-200 text-blue-700 hover:bg-blue-50">
              <CheckSquare size={14} className="mr-1" />
              {selectingAll ? 'Seleccionando…' : 'Seleccionar todos'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setListMode('criteria'); setShowList(true) }}
              className="border-indigo-200 text-indigo-700">
              <List size={14} className="mr-1" /> Lista por criterios
            </Button>
            {currentUser?.role === 'admin' && (
              <Button size="sm" variant="outline" onClick={repopularListas} disabled={repopulating}
                className="border-violet-200 text-violet-700 hover:bg-violet-50">
                <DatabaseZap size={14} className={`mr-1 ${repopulating ? 'animate-pulse' : ''}`} />
                {repopulating ? 'Repoblando…' : 'Listas casino'}
              </Button>
            )}
            <Button size="sm" onClick={() => setShowAdd(true)} className="bg-green-600 hover:bg-green-700 text-white">
              <UserPlus size={14} className="mr-1" /> Nuevo contacto
            </Button>
            <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-input rounded-md bg-background hover:bg-muted transition-colors font-medium">
              <Upload size={14} /> Importar
              <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,.vcf" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) { handleFile(f); setShowImport(true); e.target.value = '' } }} />
            </label>
          </>
        }
      />

      {/* Errores inline */}
      {updateError && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-2 text-sm text-destructive flex items-center justify-between">
          <span>{updateError}</span>
          <button onClick={() => setUpdateError(null)} className="ml-4 opacity-60 hover:opacity-100">✕</button>
        </div>
      )}
      {repopulateError && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-2 text-sm text-destructive flex items-center justify-between">
          <span>Listas casino: {repopulateError}</span>
          <button onClick={() => setRepopulateError(null)} className="ml-4 opacity-60 hover:opacity-100">✕</button>
        </div>
      )}
      {repopulateResult && (
        <div className="bg-violet-50 border border-violet-200 rounded-lg px-4 py-3 text-sm text-violet-800 flex items-start justify-between gap-4">
          <div>
            <p className="font-medium mb-1">Listas casino repobladas — {repopulateResult.total_lists} listas actualizadas</p>
            <ul className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-xs text-violet-700 mt-1">
              {repopulateResult.lists.map(l => (
                <li key={l.nombre} className="truncate">
                  {l.created ? '✅' : '🔄'} {l.nombre} — <span className="font-semibold">{l.members.toLocaleString()}</span> contactos
                </li>
              ))}
            </ul>
          </div>
          <button onClick={() => setRepopulateResult(null)} className="text-violet-400 hover:text-violet-600 shrink-0">✕</button>
        </div>
      )}

      {/* Filtros — fila 1 */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Buscar por nombre o teléfono…" value={search}
            onChange={e => { setSearch(e.target.value); resetPage() }} />
        </div>
        <Select value={filterPanel} onValueChange={v => { setFilterPanel(v ?? ''); resetPage() }}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Agente" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">Todos los agentes</SelectItem>
            {PANEL_OPTIONS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filterLinea} onValueChange={v => { setFilterLinea(v ?? ''); resetPage() }}>
          <SelectTrigger className="w-32"><SelectValue placeholder="Línea" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">Todas las líneas</SelectItem>
            {Array.from({ length: 100 }, (_, i) => i + 1).map(n => (
              <SelectItem key={n} value={String(n)}>Línea {n}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterGaming} onValueChange={v => { setFilterGaming(v ?? ''); resetPage() }}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Juego" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">Todos los juegos</SelectItem>
            <SelectItem value="slots">🎰 Slots</SelectItem>
            <SelectItem value="deportivas">⚽ Deportivas</SelectItem>
            <SelectItem value="ambas">🎯 Ambas</SelectItem>
          </SelectContent>
        </Select>
        <Select value={segment} onValueChange={v => { setSegment(v ?? ''); resetPage() }}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Nivel" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">Todos los niveles</SelectItem>
            <SelectItem value="vip">Super Vip</SelectItem>
            <SelectItem value="alto">Vip</SelectItem>
            <SelectItem value="medio">Medio</SelectItem>
            <SelectItem value="bajo">Bajo</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Filtros — fila 2: dimensiones casino */}
      <div className="flex gap-3 flex-wrap items-center">
        <Select value={filterActividad} onValueChange={v => { setFilterActividad(v ?? ''); resetPage() }}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Actividad" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">Toda actividad</SelectItem>
            <SelectItem value="frecuente">frecuente</SelectItem>
            <SelectItem value="regular">regular</SelectItem>
            <SelectItem value="ocasional">ocasional</SelectItem>
            <SelectItem value="nuevo">nuevo</SelectItem>
            <SelectItem value="en_riesgo">en riesgo</SelectItem>
            <SelectItem value="inactivo">inactivo</SelectItem>
            <SelectItem value="perdido">perdido</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterAntiguedad} onValueChange={v => { setFilterAntiguedad(v ?? ''); resetPage() }}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Antigüedad" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">Cualquier antigüedad</SelectItem>
            <SelectItem value="leal">leal</SelectItem>
            <SelectItem value="veterano">veterano</SelectItem>
            <SelectItem value="establecido">establecido</SelectItem>
            <SelectItem value="reciente">reciente</SelectItem>
            <SelectItem value="nuevo">nuevo</SelectItem>
          </SelectContent>
        </Select>
        {(filterActividad || filterAntiguedad) && (
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground h-8 px-2"
            onClick={() => { setFilterActividad(''); setFilterAntiguedad(''); resetPage() }}>
            <X size={13} className="mr-1" /> Limpiar casino
          </Button>
        )}
      </div>

      {/* Listas existentes */}
      {lists.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {lists.map(l => (
            <Badge key={l.id} variant="outline" className="cursor-pointer gap-1 py-1 px-2">
              <Users size={11} /> {l.name} <span className="text-muted-foreground">({l.contact_count})</span>
            </Badge>
          ))}
        </div>
      )}

      {/* ── DataTable ── */}
      <DataTable
        data={contacts}
        columns={columns}
        loading={loading}
        storageKey="contacts"
        getRowId={(row) => row.id}
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        manualPagination
        pageCount={Math.ceil(total / pagination.pageSize)}
        pagination={pagination}
        onPaginationChange={(next) => {
          setPagination(next)
        }}
        totalRows={total}
        emptyState={
          <DataTableEmptyState
            message="Sin contactos"
            description="Ajustá los filtros o importá nuevos contactos."
          />
        }
        bulkActions={(ids) => (
          <DataTableBulkActions
            selectedCount={ids.length}
            onClearSelection={() => setRowSelection({})}
          >
            <Button size="sm" variant="outline"
              onClick={() => { setListMode('selection'); setShowList(true) }}
              className="h-7 text-xs border-green-200 text-green-700 hover:bg-green-50">
              <List size={13} className="mr-1" /> Crear lista ({ids.length})
            </Button>
            <Button size="sm" variant="outline"
              onClick={deleteSelected}
              className="h-7 text-xs border-destructive/30 text-destructive hover:bg-destructive/10">
              <Trash2 size={13} className="mr-1" /> Eliminar ({ids.length})
            </Button>
          </DataTableBulkActions>
        )}
      />

      {/* ─── Modales (sin cambios de lógica) ─────────────────────────────── */}

      {/* Modal importación */}
      <Dialog open={showImport} onOpenChange={v => {
        if (importing) return
        setShowImport(v)
        if (!v) { setImportRows([]); setImportResult(null); setImporting(false); setImportError(null); setImportPanel(''); setImportLinea('') }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Upload size={16} /> Importar contactos</DialogTitle>
          </DialogHeader>
          {importResult ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="bg-green-50 rounded-lg p-4"><p className="text-2xl font-bold text-green-600">{importResult.inserted}</p><p className="text-xs text-muted-foreground">Creados</p></div>
                <div className="bg-blue-50 rounded-lg p-4"><p className="text-2xl font-bold text-blue-600">{importResult.updated}</p><p className="text-xs text-muted-foreground">Actualizados</p></div>
                <div className="bg-muted rounded-lg p-4"><p className="text-2xl font-bold text-muted-foreground">{importResult.skipped}</p><p className="text-xs text-muted-foreground">Omitidos</p></div>
              </div>
              <Button className="w-full" onClick={() => { setShowImport(false); setImportRows([]); setImportResult(null); setImportPanel(''); setImportLinea('') }}>Cerrar</Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {importRows.length} contactos detectados. CSV/Excel: <code className="bg-muted px-1 rounded">phone/tel/numero</code>, <code className="bg-muted px-1 rounded">name/nombre</code> · VCF: extrae <code className="bg-muted px-1 rounded">FN</code> + <code className="bg-muted px-1 rounded">TEL</code>
              </p>
              <div className="max-h-64 overflow-y-auto border border-border rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-muted sticky top-0"><tr>
                    <th className="text-left px-3 py-2 font-medium text-xs">Teléfono</th>
                    <th className="text-left px-3 py-2 font-medium text-xs">Nombre</th>
                    <th className="text-left px-3 py-2 font-medium text-xs">Nivel</th>
                  </tr></thead>
                  <tbody>
                    {importRows.slice(0, 50).map((r, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="px-3 py-1.5 font-mono text-xs">{r.phone}</td>
                        <td className="px-3 py-1.5 text-xs">{r.name || '—'}</td>
                        <td className="px-3 py-1.5 text-xs">{r.segment || '—'}</td>
                      </tr>
                    ))}
                    {importRows.length > 50 && <tr><td colSpan={3} className="px-3 py-2 text-muted-foreground text-xs">…y {importRows.length - 50} más</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Agente (opcional)</label>
                  <Select value={importPanel || 'none'} onValueChange={v => setImportPanel(v === 'none' ? '' : (v ?? ''))}>
                    <SelectTrigger><SelectValue placeholder="Sin asignar" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Sin asignar</SelectItem>
                      {PANEL_OPTIONS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Línea (opcional)</label>
                  <Select value={importLinea || 'none'} onValueChange={v => setImportLinea(v === 'none' ? '' : (v ?? ''))}>
                    <SelectTrigger><SelectValue placeholder="Sin asignar" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Sin asignar</SelectItem>
                      {Array.from({ length: 100 }, (_, i) => i + 1).map(n => (
                        <SelectItem key={n} value={String(n)}>Línea {n}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {importError && <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">{importError}</p>}
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setShowImport(false)} disabled={importing}>Cancelar</Button>
                <Button className="flex-1 bg-green-600 hover:bg-green-700" onClick={confirmImport} disabled={importing}>
                  {importing ? 'Importando…' : `Importar ${importRows.length} contactos`}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Modal crear lista */}
      <Dialog open={showList} onOpenChange={v => {
        if (savingList) return
        setShowList(v)
        if (!v) { setNewListName(''); setListMode('selection'); setCriteriaPanel(''); setCriteriaGaming(''); setCriteriaSegment(''); setCriteriaActividad(''); setCriteriaAntiguedad(''); setSavingList(false); setListError(null) }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><CheckSquare size={16} /> Crear lista de distribución</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex rounded-lg border border-border overflow-hidden text-sm">
              <button onClick={() => setListMode('selection')}
                className={`flex-1 py-2 font-medium transition-colors ${listMode === 'selection' ? 'bg-green-600 text-white' : 'bg-background text-muted-foreground hover:bg-muted'}`}>
                Desde selección {selectedCount > 0 && `(${selectedCount})`}
              </button>
              <button onClick={() => setListMode('criteria')}
                className={`flex-1 py-2 font-medium transition-colors ${listMode === 'criteria' ? 'bg-indigo-600 text-white' : 'bg-background text-muted-foreground hover:bg-muted'}`}>
                Por criterios
              </button>
            </div>
            {listMode === 'selection' ? (
              <p className="text-sm text-muted-foreground">
                {selectedCount === 0 ? 'Seleccioná contactos en la tabla primero.' : `${selectedCount} contactos seleccionados.`}
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">Se incluirán todos los contactos que cumplan los criterios elegidos.</p>
                <div className="grid grid-cols-1 gap-2">
                  {[
                    { label: 'Agente', value: criteriaPanel, set: setCriteriaPanel, key: 'all-agent', items: PANEL_OPTIONS.map(p => ({ v: p, l: p })) },
                    { label: 'Juego', value: criteriaGaming, set: setCriteriaGaming, key: 'all-game', items: [{ v: 'slots', l: '🎰 Slots' }, { v: 'deportivas', l: '⚽ Deportivas' }, { v: 'ambas', l: '🎯 Ambas' }] },
                    { label: 'Nivel', value: criteriaSegment, set: setCriteriaSegment, key: 'all-seg', items: [{ v: 'vip', l: 'Super Vip' }, { v: 'alto', l: 'Vip' }, { v: 'medio', l: 'Medio' }, { v: 'bajo', l: 'Bajo' }] },
                  ].map(({ label, value, set, key, items }) => (
                    <div key={key}>
                      <label className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
                      <Select value={value || 'all'} onValueChange={v => set(v === 'all' ? '' : (v ?? ''))}>
                        <SelectTrigger><SelectValue placeholder={`Cualquier ${label.toLowerCase()}`} /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Cualquier {label.toLowerCase()}</SelectItem>
                          {items.map(i => <SelectItem key={i.v} value={i.v}>{i.l}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                  <div className="border-t border-border pt-2">
                    <p className="text-xs font-medium text-muted-foreground mb-2">Casino (tags)</p>
                  </div>
                  {[
                    { label: 'Actividad', value: criteriaActividad, set: setCriteriaActividad, key: 'all-act', items: ['frecuente', 'regular', 'ocasional', 'nuevo', 'en_riesgo', 'inactivo', 'perdido'].map(v => ({ v, l: v })) },
                    { label: 'Antigüedad', value: criteriaAntiguedad, set: setCriteriaAntiguedad, key: 'all-ant', items: ['leal', 'veterano', 'establecido', 'reciente', 'nuevo'].map(v => ({ v, l: v })) },
                  ].map(({ label, value, set, key, items }) => (
                    <div key={key}>
                      <label className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
                      <Select value={value || 'all'} onValueChange={v => set(v === 'all' ? '' : (v ?? ''))}>
                        <SelectTrigger><SelectValue placeholder={`Cualquier ${label.toLowerCase()}`} /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Cualquier {label.toLowerCase()}</SelectItem>
                          {items.map(i => <SelectItem key={i.v} value={i.v}>{i.l}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <Input placeholder="Nombre de la lista (ej: Betcoin Slots VIP)" value={newListName} onChange={e => setNewListName(e.target.value)} />
            {listError && <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-2">{listError}</p>}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setShowList(false)} disabled={savingList}><X size={14} /> Cancelar</Button>
              <Button
                className={`flex-1 ${listMode === 'criteria' ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-green-600 hover:bg-green-700'}`}
                onClick={createList}
                disabled={savingList || !newListName || (listMode === 'selection' && selectedCount === 0) || (listMode === 'criteria' && !criteriaPanel && !criteriaGaming && !criteriaSegment && !criteriaActividad && !criteriaAntiguedad)}>
                {savingList ? 'Guardando…' : 'Crear lista'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal nuevo contacto */}
      <Dialog open={showAdd} onOpenChange={v => {
        setShowAdd(v)
        if (!v) { setNewPhone(''); setNewName(''); setNewPanel(''); setNewGaming(''); setNewSegment(''); setNewLinea(''); setAddError(''); setAddSaving(false) }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><UserPlus size={16} /> Nuevo contacto</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Teléfono <span className="text-destructive">*</span></label>
              <Input placeholder="Ej: 5492236123456" value={newPhone} onChange={e => setNewPhone(e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Nombre completo</label>
              <Input placeholder="Ej: Juan Pérez" value={newName} onChange={e => setNewName(e.target.value)} />
            </div>
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: 'Panel', value: newPanel, set: setNewPanel, items: PANEL_OPTIONS.map(p => ({ v: p, l: p })), ph: 'Panel' },
                { label: 'Línea', value: newLinea, set: setNewLinea, items: Array.from({ length: 100 }, (_, i) => ({ v: String(i + 1), l: `Línea ${i + 1}` })), ph: 'Línea' },
                { label: 'Juego', value: newGaming, set: setNewGaming, items: [{ v: 'slots', l: '🎰 Slots' }, { v: 'deportivas', l: '⚽ Deportivas' }, { v: 'ambas', l: '🎯 Ambas' }], ph: 'Juego' },
                { label: 'Nivel', value: newSegment, set: setNewSegment, items: [{ v: 'vip', l: 'Super Vip' }, { v: 'alto', l: 'Vip' }, { v: 'medio', l: 'Medio' }, { v: 'bajo', l: 'Bajo' }], ph: 'Nivel' },
              ].map(({ label, value, set, items, ph }) => (
                <div key={label}>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
                  <Select value={value} onValueChange={v => set(v ?? '')}>
                    <SelectTrigger><SelectValue placeholder={ph} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">Sin {label.toLowerCase()}</SelectItem>
                      {items.map(i => <SelectItem key={i.v} value={i.v}>{i.l}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            {addError && <p className="text-xs text-destructive">{addError}</p>}
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setShowAdd(false)}><X size={14} /> Cancelar</Button>
              <Button className="flex-1 bg-green-600 hover:bg-green-700" onClick={addContact} disabled={addSaving}>
                {addSaving ? 'Guardando…' : 'Guardar contacto'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {/* ── Modal editar contacto ── */}
      <Dialog open={!!editContact} onOpenChange={v => { if (!v) setEditContact(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Pencil size={16} /> Editar contacto</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Teléfono</label>
              <Input value={editContact?.phone_number || ''} disabled className="font-mono text-sm bg-muted/50" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Nombre</label>
                <Input placeholder="Nombre" value={editFirstName} onChange={e => setEditFirstName(e.target.value)} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Apellido</label>
                <Input placeholder="Apellido" value={editLastName} onChange={e => setEditLastName(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: 'Panel',  value: editPanel,   set: setEditPanel,   items: PANEL_OPTIONS.map(p => ({ v: p, l: p })),                                                                                          ph: 'Panel'  },
                { label: 'Línea',  value: editLinea,   set: setEditLinea,   items: Array.from({ length: 100 }, (_, i) => ({ v: String(i + 1), l: `Línea ${i + 1}` })),                                               ph: 'Línea'  },
                { label: 'Juego',  value: editGaming,  set: setEditGaming,  items: [{ v: 'slots', l: '🎰 Slots' }, { v: 'deportivas', l: '⚽ Deportivas' }, { v: 'ambas', l: '🎯 Ambas' }],                         ph: 'Juego'  },
                { label: 'Nivel',  value: editSegment, set: setEditSegment, items: [{ v: 'vip', l: 'Super Vip' }, { v: 'alto', l: 'Vip' }, { v: 'medio', l: 'Medio' }, { v: 'bajo', l: 'Bajo' }],                   ph: 'Nivel'  },
              ].map(({ label, value, set, items, ph }) => (
                <div key={label}>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
                  <Select value={value} onValueChange={v => set(v ?? '')}>
                    <SelectTrigger><SelectValue placeholder={ph} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">Sin {label.toLowerCase()}</SelectItem>
                      {items.map(i => <SelectItem key={i.v} value={i.v}>{i.l}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            {editError && <p className="text-xs text-destructive">{editError}</p>}
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setEditContact(null)} disabled={editSaving}>
                <X size={14} className="mr-1" /> Cancelar
              </Button>
              <Button className="flex-1" onClick={saveEdit} disabled={editSaving}>
                {editSaving ? 'Guardando…' : 'Guardar cambios'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
