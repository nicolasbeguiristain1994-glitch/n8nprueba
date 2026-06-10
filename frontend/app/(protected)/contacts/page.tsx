'use client'
import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import * as XLSX from 'xlsx'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Search, Upload, RefreshCw, List, CheckSquare, X, Users, UserPlus,
  Trash2, Download, DatabaseZap, Pencil, ChevronDown, Filter, Info, Scissors,
  Tag, Ban,
} from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { DownloadContactsModal } from '@/components/contacts/DownloadContactsModal'
import { PageHeader } from '@/components/layout/PageHeader'
import { ProspectsTab } from '@/components/prospects/ProspectsTab'
import { ProspectListsTab } from '@/components/prospects/ProspectListsTab'
import {
  DataTable,
  DataTableColumnHeader,
  DataTableBulkActions,
  DataTableActionButton,
  DataTableRowActions,
  DataTableEmptyState,
  EditableCell,
  EditableTextCell,
} from '@/components/data-display/DataTable'
import type { ColumnDef, RowSelectionState, PaginationState } from '@/components/data-display/DataTable'

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

interface Contact {
  id: string; phone_number: string; first_name: string; last_name: string
  email: string; status: string; opt_in: boolean; created_at: string; segment: string; panel: string; gaming: string; linea: number | null
  actividad?: string; valor_riesgo?: string; antiguedad?: string
  last_deposit_at?: string | null; total_deposits?: number; total_withdrawals?: number
  platforms?: string[]; casino_accounts?: Array<{ panel: string; username: string }>; custom_tags?: string[]
}
interface ImportRow   { phone: string; name?: string; segment?: string }
interface ContactList { id: string; name: string; contact_count: number; created_at: string }

// ─────────────────────────────────────────────────────────────────────────────
// Constantes de dominio
// ─────────────────────────────────────────────────────────────────────────────

const PANEL_OPTIONS = ['betcoin', 'bigwin', 'farabet', 'ofizeus', 'royal']

const NIVEL_LABEL: Record<string, string> = {
  bajo: 'Bajo', medio: 'Medio', vip: 'Vip Bajo',
  vip_medio: 'Vip Medio', vip_alto: 'Vip Alto', super_vip: 'Super Vip',
}

const SEGMENT_STYLE: Record<string, string> = {
  casual: 'bg-gray-100 text-gray-600', regular: 'bg-blue-100 text-blue-700',
  super_vip: 'bg-purple-100 text-purple-700', whale: 'bg-amber-100 text-amber-700',
  bajo: 'bg-orange-50 text-orange-700', medio: 'bg-slate-100 text-slate-600',
  vip: 'bg-yellow-100 text-yellow-700',
  vip_medio: 'bg-orange-100 text-orange-700',
  vip_alto:  'bg-red-100 text-red-700',
}
const ACTIVIDAD_STYLE: Record<string, string> = {
  frecuente: 'bg-green-100 text-green-700', regular: 'bg-blue-100 text-blue-700',
  ocasional: 'bg-gray-100 text-gray-600', nuevo: 'bg-cyan-100 text-cyan-700',
  en_riesgo: 'bg-orange-100 text-orange-700', inactivo: 'bg-red-100 text-red-600',
  perdido: 'bg-zinc-800 text-white',
}
const ACTIVIDAD_DESC: Record<string, string> = {
  frecuente: '≥ 3 cargas por semana en promedio',
  regular:   '1–2 cargas por semana en promedio',
  ocasional: '1–3 cargas al mes',
  nuevo:     'Primera semana de actividad',
  en_riesgo: 'Sin actividad en las últimas 2–4 semanas',
  inactivo:  'Sin actividad entre 1 y 3 meses',
  perdido:   'Sin actividad por más de 3 meses',
}
const ANTIGUEDAD_DESC: Record<string, string> = {
  leal:        'Cliente por más de 1 año',
  veterano:    'Entre 6 y 12 meses de historia',
  establecido: 'Entre 3 y 6 meses',
  reciente:    'Entre 1 y 3 meses',
  nuevo:       'Menos de 1 mes',
}
const NIVEL_DESC: Record<string, string> = {
  super_vip: 'Super Vip — depósitos >= $3.200.000/mes activo',
  vip_alto:  'Vip Alto — depósitos $1.500.001 – $3.199.999/mes activo',
  vip_medio: 'Vip Medio — depósitos $1.000.000 – $1.500.000/mes activo',
  vip:       'Vip Bajo — depósitos $500.000 – $999.999/mes activo',
  medio:     'Medio — depósitos $100.000 – $499.999/mes activo',
  bajo:      'Bajo — depósitos < $100.000/mes activo',
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

const TOOLTIP_WIDTH = 210 // px — coincide con max-w-[210px]

function SegmentItem({ value, label, desc }: { value: string; label: string; desc: string }) {
  const [pos, setPos] = useState<{ x: number; y: number; flip: boolean } | null>(null)

  const handleMouseEnter = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const spaceRight = window.innerWidth - r.right - 10
    const flip = spaceRight < TOOLTIP_WIDTH
    setPos({
      x: flip ? r.left - TOOLTIP_WIDTH - 10 : r.right + 10,
      y: r.top + r.height / 2,
      flip,
    })
  }

  return (
    <>
      <SelectItem value={value} onMouseEnter={handleMouseEnter} onMouseLeave={() => setPos(null)}>
        {label}
      </SelectItem>
      {pos && typeof document !== 'undefined' && createPortal(
        <div
          style={{ position: 'fixed', left: pos.x, top: pos.y, transform: 'translateY(-50%)', zIndex: 9999, width: TOOLTIP_WIDTH }}
          className="rounded-md bg-gray-600 text-white text-xs px-2.5 py-1.5 shadow-lg pointer-events-none leading-snug"
        >
          {desc}
        </div>,
        document.body
      )}
    </>
  )
}

// Detect zeus/bet30: suffix z/ze/zs/zeus or b/bt/be (+ optional digits)
// at end of string OR before a separator (/ or whitespace).
const ZEUS_TOKEN_RE  = /z(e|s|eus)?\d*(\/|\s|$)/i
const BET30_TOKEN_RE = /b(t|e)?\d*(\/|\s|$)/i

function detectClientPlatforms(first: string | null, last: string | null): string[] {
  const full = `${first || ''} ${last || ''}`
  const platforms: string[] = []
  if (ZEUS_TOKEN_RE.test(full))  platforms.push('zeus')
  if (BET30_TOKEN_RE.test(full)) platforms.push('bet30')
  return platforms
}

// ─────────────────────────────────────────────────────────────────────────────
// Página
// ─────────────────────────────────────────────────────────────────────────────

export default function Contacts() {
  // ── Tab activo ────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'contacts' | 'prospects' | 'prospect-lists'>('contacts')

  // ── Datos ─────────────────────────────────────────────────────────────────
  const [contacts, setContacts] = useState<Contact[]>([])
  const [total, setTotal]       = useState(0)
  const [loading, setLoading]   = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // ── Filtros ───────────────────────────────────────────────────────────────
  const [search, setSearch]                   = useState('')
  const [segments, setSegments]               = useState<string[]>([])
  const [segmentDropdownOpen, setSegmentDropdownOpen] = useState(false)
  const segmentDropdownRef = useRef<HTMLDivElement>(null)
  const [filterGaming, setFilterGaming]       = useState('')
  const [filterPanel, setFilterPanel]         = useState('')
  const [filterLinea, setFilterLinea]         = useState('')
  const [filterActividad, setFilterActividad]   = useState<string[]>([])
  const [actividadOpen, setActividadOpen]       = useState(false)
  const actividadRef = useRef<HTMLDivElement>(null)
  const [filterAntiguedad, setFilterAntiguedad] = useState<string[]>([])
  const [antiguedadOpen, setAntiguedadOpen]     = useState(false)
  const antiguedadRef = useRef<HTMLDivElement>(null)
  const [filterPlataforma, setFilterPlataforma] = useState('')
  const [filterSinMovimiento, setFilterSinMovimiento] = useState(false)
  const [filterTag, setFilterTag]                     = useState('')

  // ── Paginación (TanStack format) ──────────────────────────────────────────
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 50 })

  // ── Selección (TanStack format) ───────────────────────────────────────────
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const selectedIds   = Object.keys(rowSelection)
  const selectedCount = selectedIds.length

  // ── Listas ────────────────────────────────────────────────────────────────
  const [lists, setLists]             = useState<ContactList[]>([])
  const [filterList, setFilterList]   = useState('')
  const [showListsMenu, setShowListsMenu] = useState(false)
  const [deletingListId, setDeletingListId] = useState<string | null>(null)
  const listsMenuRef = useRef<HTMLDivElement>(null)

  // ── Import modal ─────────────────────────────────────────────────────────
  const [showImport, setShowImport]     = useState(false)
  const [importRows, setImportRows]     = useState<ImportRow[]>([])
  const [importPanel, setImportPanel]   = useState('')
  const [importPanel2, setImportPanel2] = useState('')
  const [importLinea, setImportLinea]   = useState('')
  const [importing, setImporting]       = useState(false)
  const [importProgress, setImportProgress] = useState(0)
  const [importResult, setImportResult] = useState<{ inserted: number; updated: number; skipped: number } | null>(null)
  const [importError, setImportError]   = useState<string | null>(null)
  const [importCheck, setImportCheck]   = useState<{ total: number; by_panel: Record<string, number> } | null>(null)
  const [checkLoading, setCheckLoading] = useState(false)
  const [conflictMode, setConflictMode] = useState<'update' | 'panels_only' | 'skip'>('update')
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

  // ── View contact modal ────────────────────────────────────────────────────
  const [viewContact, setViewContact]   = useState<Contact | null>(null)
  const [casinoStats, setCasinoStats]   = useState<{
    monto_cargas_mes: number; monto_retiros_mes: number; last_deposit_at: string | null
    mes_referencia: string | null; fuente: 'transactions' | 'historico' | null
    bet30?: { monto_cargas_mes: number; monto_retiros_mes: number; last_deposit_at: string | null; mes_referencia: string | null; fuente: 'transactions' | 'historico' } | null
  } | null>(null)

  const openViewContact = (c: Contact) => {
    setViewContact(c)
    setCasinoStats(null)
    fetch(`/api/contacts/${c.id}/casino-stats`)
      .then(r => r.json())
      .then(d => setCasinoStats(d))
      .catch(() => {})
  }

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

  // ── Tags de contacto ─────────────────────────────────────────────────────
  const [tagsContact, setTagsContact]   = useState<Contact | null>(null)
  const [tagsValue, setTagsValue]       = useState<string[]>([])
  const [tagsInput, setTagsInput]       = useState('')
  const [tagsSaving, setTagsSaving]     = useState(false)
  const [tagsError, setTagsError]       = useState<string | null>(null)

  // ── Blacklist ─────────────────────────────────────────────────────────────
  const [blacklistSaving, setBlacklistSaving] = useState(false)

  // ── Split lista ───────────────────────────────────────────────────────────
  const [splitSource, setSplitSource]   = useState<ContactList | null>(null)
  const [splitParts, setSplitParts]     = useState<2 | 3>(2)
  const [splitNames, setSplitNames]     = useState<string[]>(['', ''])
  const [splittingList, setSplittingList] = useState(false)
  const [splitError, setSplitError]     = useState<string | null>(null)
  const [splitResult, setSplitResult]   = useState<{ id: string; name: string; total: number }[] | null>(null)

  // ── Misc ──────────────────────────────────────────────────────────────────
  const [updateError, setUpdateError]           = useState<string | null>(null)
  const [showDownloadModal, setShowDownloadModal] = useState(false)
  const [downloadList, setDownloadList]           = useState<ContactList | null>(null)
  const [selectingAll, setSelectingAll]           = useState(false)
  const [repopulating, setRepopulating]         = useState(false)
  const [repopulateResult, setRepopulateResult] = useState<{ total_lists: number; lists: Array<{ nombre: string; members: number; created: boolean }> } | null>(null)
  const [repopulateError, setRepopulateError]   = useState<string | null>(null)

  const { user: currentUser, permissions } = useCurrentUser()
  const canCreateContacts = permissions.contacts?.includes('create') ?? false

  // ── Carga de datos ────────────────────────────────────────────────────────

  const load = useCallback(() => {
    setLoading(true)
    const q = new URLSearchParams({
      q: search, page: String(pagination.pageIndex + 1),
      segment: segments.join(','), gaming: filterGaming, panel: filterPanel.trim(),
      linea: filterLinea, actividad: filterActividad.join(','), antiguedad: filterAntiguedad.join(','),
      ...(filterList          ? { list_id: filterList }          : {}),
      ...(filterPlataforma    ? { plataforma: filterPlataforma } : {}),
      ...(filterSinMovimiento ? { sin_movimiento: 'true' }       : {}),
      ...(filterTag           ? { tag: filterTag }               : {}),
    })
    setLoadError(null)
    fetchJson<{ contacts: Contact[]; total: number }>(`/api/contacts?${q}`)
      .then(d => { setContacts(d.contacts || []); setTotal(d.total || 0) })
      .catch((e: unknown) => {
        setContacts([])
        setTotal(0)
        setLoadError(e instanceof Error ? e.message : 'Error al cargar contactos')
      })
      .finally(() => setLoading(false))
  }, [search, pagination.pageIndex, segments, filterGaming, filterPanel, filterLinea, filterActividad, filterAntiguedad, filterList, filterPlataforma, filterSinMovimiento, filterTag])

  useEffect(() => { load() }, [load])
  const reloadLists = useCallback(() => {
    fetchJson<{ lists: ContactList[] }>('/api/lists')
      .then(d => setLists(d.lists || []))
      .catch(() => setLists([]))
  }, [])

  useEffect(() => { reloadLists() }, [reloadLists])

  // Cerrar dropdown de listas al hacer click fuera
  useEffect(() => {
    if (!showListsMenu) return
    const handler = (e: MouseEvent) => {
      if (listsMenuRef.current && !listsMenuRef.current.contains(e.target as Node)) {
        setShowListsMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showListsMenu])


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
        q: search, segment: segments.join(','), gaming: filterGaming, panel: filterPanel.trim(),
        linea: filterLinea, actividad: filterActividad.join(','), antiguedad: filterAntiguedad.join(','),
        select_all: 'true',
        ...(filterPlataforma    ? { plataforma: filterPlataforma } : {}),
        ...(filterList          ? { list_id: filterList }          : {}),
        ...(filterSinMovimiento ? { sin_movimiento: 'true' }       : {}),
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
      setImportCheck(null)
      setConflictMode('update')
      // Verificar cuántos ya existen en la DB
      if (rows.length > 0) {
        setCheckLoading(true)
        const phones = rows.map(r => r.phone).filter(Boolean)
        fetch('/api/contacts/import/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phones }),
        })
          .then(r => r.json())
          .then(data => setImportCheck(data))
          .catch(() => setImportCheck(null))
          .finally(() => setCheckLoading(false))
      }
    }
    if (file.name.endsWith('.csv') || file.name.endsWith('.vcf')) reader.readAsText(file)
    else reader.readAsBinaryString(file)
  }

  const confirmImport = async () => {
    setImporting(true); setImportError(null); setImportProgress(0)

    const CHUNK_SIZE = 5_000
    const panels = [importPanel, importPanel2].filter(Boolean) as string[]
    const linea  = importLinea ? Number(importLinea) : undefined
    const chunks: ImportRow[][] = []
    for (let i = 0; i < importRows.length; i += CHUNK_SIZE) chunks.push(importRows.slice(i, i + CHUNK_SIZE))

    let totalInserted = 0, totalUpdated = 0, totalSkipped = 0

    try {
      for (let i = 0; i < chunks.length; i++) {
        const res = await fetch('/api/contacts/import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contacts: chunks[i], panels, linea, conflict_mode: conflictMode }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) { setImportError(data.error || 'Error al importar'); return }
        totalInserted += data.inserted || 0
        totalUpdated  += data.updated  || 0
        totalSkipped  += data.skipped  || 0
        setImportProgress(Math.round(((i + 1) / chunks.length) * 100))
      }
      setImportResult({ inserted: totalInserted, updated: totalUpdated, skipped: totalSkipped })
      load()
    } catch {
      setImportError('Error de red al importar')
    } finally {
      setImporting(false)
    }
  }

  // ── Export ────────────────────────────────────────────────────────────────

  const buildFilterStr = () =>
    [
      filterPanel      && `panel-${filterPanel}`,
      filterGaming     && `juego-${filterGaming}`,
      segments.length  && `nivel-${segments.join('-')}`,
      search           && `busq-${search}`,
      filterActividad.length  && `actividad-${filterActividad.join('-')}`,
      filterAntiguedad.length && `antiguedad-${filterAntiguedad.join('-')}`,
    ].filter(Boolean).join('_') || 'todos'

  const buildDownloadParams = (): URLSearchParams => {
    const p = new URLSearchParams({
      q: search, segment: segments.join(','), gaming: filterGaming, panel: filterPanel.trim(),
      linea: filterLinea, actividad: filterActividad.join(','), antiguedad: filterAntiguedad.join(','),
    })
    if (filterList)          p.set('list_id', filterList)
    if (filterPlataforma)    p.set('plataforma', filterPlataforma)
    if (filterSinMovimiento) p.set('sin_movimiento', 'true')
    return p
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
    reloadLists()
  }

  const deleteList = async (listId: string, listName: string) => {
    if (!confirm(`¿Eliminar la lista "${listName}"? Esta acción no se puede deshacer.`)) return
    setDeletingListId(listId)
    try {
      const res = await fetch(`/api/lists/${listId}`, { method: 'DELETE' })
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Error al eliminar la lista'); return }
      if (filterList === listId) { setFilterList(''); resetPage() }
      setLists(prev => prev.filter(l => l.id !== listId))
    } catch { alert('Error de conexión') }
    finally { setDeletingListId(null) }
  }

  const openSplitModal = (l: ContactList) => {
    setSplitSource(l)
    setSplitParts(2)
    setSplitNames([`${l.name} (1/2)`, `${l.name} (2/2)`])
    setSplitError(null)
    setSplitResult(null)
    setShowListsMenu(false)
  }

  const handleSplitPartsChange = (p: 2 | 3, sourceName: string) => {
    setSplitParts(p)
    setSplitNames(Array.from({ length: p }, (_, i) => `${sourceName} (${i + 1}/${p})`))
  }

  const doSplit = async () => {
    if (!splitSource) return
    setSplittingList(true); setSplitError(null)
    try {
      const res = await fetch(`/api/lists/${splitSource.id}/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: splitParts, names: splitNames }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setSplitError(d.error || 'Error al dividir la lista'); return }
      setSplitResult(d.lists)
      reloadLists()
    } catch { setSplitError('Error de conexión') }
    finally { setSplittingList(false) }
  }

  const repopularListas = async () => {
    setRepopulating(true); setRepopulateError(null); setRepopulateResult(null)
    try {
      const res = await fetch('/api/lists/casino/repopulate', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setRepopulateError(data.error || 'Error al repoblar listas') }
      else { setRepopulateResult(data); reloadLists() }
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

  // ── Tags ──────────────────────────────────────────────────────────────────

  const openTags = (c: Contact) => {
    setTagsContact(c)
    setTagsValue(c.custom_tags ?? [])
    setTagsInput('')
    setTagsError(null)
  }

  const addTag = () => {
    const t = tagsInput.trim().toLowerCase().replace(/[^a-z0-9_\- ]/g, '')
    if (!t || tagsValue.includes(t)) { setTagsInput(''); return }
    setTagsValue(prev => [...prev, t])
    setTagsInput('')
  }

  const removeTag = (t: string) => setTagsValue(prev => prev.filter(x => x !== t))

  const saveTags = async () => {
    if (!tagsContact) return
    setTagsSaving(true); setTagsError(null)
    // Si hay texto en el input, lo agregamos antes de guardar
    const pending = tagsInput.trim().toLowerCase().replace(/[^a-z0-9_\- ]/g, '')
    const finalTags = pending && !tagsValue.includes(pending)
      ? [...tagsValue, pending]
      : tagsValue
    if (pending) { setTagsValue(finalTags); setTagsInput('') }
    try {
      const res = await fetch(`/api/contacts/${tagsContact.id}/tags`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: finalTags }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setTagsError(data.error || 'Error al guardar'); return }
      setContacts(cs => cs.map(c => c.id === tagsContact.id ? { ...c, custom_tags: finalTags } : c))
      setTagsContact(null)
    } catch { setTagsError('Error de conexión') }
    finally { setTagsSaving(false) }
  }

  // ── Blacklist ──────────────────────────────────────────────────────────────

  const sendToBlacklist = async (phones: string[], onDone?: () => void) => {
    setBlacklistSaving(true)
    try {
      const res = await fetch('/api/blacklist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phones }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { alert(data.error || 'Error al agregar a blacklist'); return }
      onDone?.()
    } catch { alert('Error de conexión') }
    finally { setBlacklistSaving(false) }
  }

  const blacklistContact = async (c: Contact) => {
    if (!confirm(`¿Agregar ${c.first_name || c.phone_number} a la blacklist?`)) return
    await sendToBlacklist([c.phone_number], () => {
      setViewContact(null)
      alert('Contacto agregado a la blacklist.')
    })
  }

  const blacklistSelected = async () => {
    if (!selectedCount) return
    if (!confirm(`¿Agregar ${selectedCount} contactos a la blacklist?`)) return
    const phones = contacts.filter(c => rowSelection[c.id]).map(c => c.phone_number)
    await sendToBlacklist(phones, () => {
      setRowSelection({})
      alert(`${phones.length} contactos agregados a la blacklist.`)
    })
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
      cell: ({ row }) => {
        const full = [row.original.first_name, row.original.last_name].filter(Boolean).join(' ')
        // Use client-side detection when DB platforms is empty (fallback for unprocessed contacts)
        const platforms = row.original.platforms?.length
          ? row.original.platforms
          : detectClientPlatforms(row.original.first_name, row.original.last_name)
        const hasName   = !!(row.original.first_name || row.original.last_name)
        const customTags = row.original.custom_tags ?? []
        return (
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <EditableTextCell
                value={full}
                placeholder="— sin nombre"
                onSave={newName => {
                  const trimmed = newName.trim()
                  const parts   = trimmed ? trimmed.split(/\s+/) : []
                  const first   = parts[0] || null
                  const last    = parts.slice(1).join(' ') || null
                  updateField(row.original.id, 'first_name', first)
                  if (last !== (row.original.last_name || null)) updateField(row.original.id, 'last_name', last)
                }}
              />
              {platforms.includes('zeus')  && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-blue-100 text-blue-700">Zeus</span>}
              {platforms.includes('bet30') && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-orange-100 text-orange-700">Bet30</span>}
              {platforms.length === 0 && hasName && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-gray-100 text-gray-500">otros</span>}
            </div>
            {customTags.length > 0 && (
              <div className="flex flex-wrap gap-1" onClick={e => e.stopPropagation()}>
                {customTags.map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => { setFilterTag(t); resetPage() }}
                    className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium border transition-colors cursor-pointer hover:bg-indigo-100 ${filterTag === t ? 'bg-indigo-200 border-indigo-400 text-indigo-800' : 'bg-indigo-50 text-indigo-600 border-indigo-200'}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      },
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
            { value: 'super_vip', label: 'Super Vip' },
            { value: 'vip_alto',  label: 'Vip Alto' },
            { value: 'vip_medio', label: 'Vip Medio' },
            { value: 'vip',       label: 'Vip Bajo' },
            { value: 'medio',     label: 'Medio' },
            { value: 'bajo',      label: 'Bajo' },
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
      cell: ({ row }) => {
        const c = row.original
        // Badge: solo 1 depósito y han pasado más de 10 días desde la primera carga
        const soloUnDeposito = c.total_deposits === 1 && c.last_deposit_at
          ? (Date.now() - new Date(c.last_deposit_at).getTime()) > 10 * 24 * 60 * 60 * 1000
          : false
        return (
          <div className="flex flex-col gap-0.5">
            {soloUnDeposito && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap bg-amber-100 text-amber-700 border border-amber-200">
                1er dep. · 10d+
              </span>
            )}
            {c.valor_riesgo && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap ${VALOR_RIESGO_STYLE[c.valor_riesgo] ?? 'bg-gray-100 text-gray-600'}`}>
                ⚠ {c.valor_riesgo}
              </span>
            )}
            {c.antiguedad && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap ${ANTIGUEDAD_STYLE[c.antiguedad] ?? 'bg-gray-100 text-gray-600'}`}>
                {c.antiguedad}
              </span>
            )}
            {!soloUnDeposito && !c.valor_riesgo && !c.antiguedad && (
              <span className="text-muted-foreground/40 text-xs">—</span>
            )}
          </div>
        )
      },
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
            onClick={() => openViewContact(row.original)}
            icon={Info}
            label="Más información"
          />
          <DataTableActionButton
            onClick={() => openEdit(row.original)}
            icon={Pencil}
            label="Editar contacto"
          />
          <DataTableActionButton
            onClick={() => openTags(row.original)}
            icon={Tag}
            label="Editar etiquetas"
          />
          <DataTableActionButton
            onClick={() => blacklistContact(row.original)}
            icon={Ban}
            label="Agregar a blacklist"
            variant="destructive"
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
      {/* ── Tab switcher ── */}
      <div className="flex gap-1 border-b pb-0">
        <button
          onClick={() => setActiveTab('contacts')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'contacts'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          Contactos
        </button>
        <button
          onClick={() => setActiveTab('prospects')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'prospects'
              ? 'border-emerald-600 text-emerald-600'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          Base de Difusión
        </button>
        <button
          onClick={() => setActiveTab('prospect-lists')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'prospect-lists'
              ? 'border-violet-600 text-violet-600'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          Listas de Difusión
        </button>
      </div>

      {activeTab === 'prospects' && <ProspectsTab />}
      {activeTab === 'prospect-lists' && <ProspectListsTab />}

      {activeTab === 'contacts' && <>
      <PageHeader
        title="Contactos"
        count={total}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </Button>

            {currentUser?.can_download_contacts && (
              <Button variant="outline" size="sm"
                onClick={() => setShowDownloadModal(true)}
                className="border-teal-200 text-teal-700 hover:bg-teal-50">
                <Download size={14} className="mr-1" /> Descargar
              </Button>
            )}

            <Button size="sm" variant="outline" onClick={selectAllFiltered} disabled={selectingAll}
              className="border-blue-200 text-blue-700 hover:bg-blue-50">
              <CheckSquare size={14} className="mr-1" />
              {selectingAll ? 'Seleccionando…' : 'Seleccionar todos'}
            </Button>
            {/* Botón Listas — dropdown con todas las listas */}
            <div className="relative" ref={listsMenuRef}>
              <Button
                size="sm" variant="outline"
                onClick={() => setShowListsMenu(v => !v)}
                className={`border-indigo-200 text-indigo-700 hover:bg-indigo-50 ${filterList ? 'bg-indigo-50 border-indigo-400' : ''}`}
              >
                <List size={14} className="mr-1" />
                {filterList ? (lists.find(l => l.id === filterList)?.name ?? 'Lista') : 'Listas'}
                {filterList && <X size={11} className="ml-1.5 opacity-60 hover:opacity-100" onClick={e => { e.stopPropagation(); setFilterList(''); resetPage() }} />}
                {!filterList && <ChevronDown size={12} className="ml-1 opacity-60" />}
              </Button>
              {showListsMenu && (
                <div className="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-30 w-72 py-1 max-h-80 overflow-y-auto">
                  <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Mis listas</span>
                    <button
                      className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                      onClick={() => { setShowListsMenu(false); setListMode('criteria'); setShowList(true) }}
                    >
                      + Nueva lista
                    </button>
                  </div>
                  {lists.length === 0 && (
                    <p className="text-xs text-gray-400 px-3 py-4 text-center">No hay listas creadas</p>
                  )}
                  {lists.map(l => (
                    <div
                      key={l.id}
                      className={`flex items-center gap-2 px-3 py-2.5 hover:bg-gray-50 cursor-pointer group ${filterList === l.id ? 'bg-indigo-50' : ''}`}
                      onClick={() => { setFilterList(l.id); resetPage(); setShowListsMenu(false) }}
                    >
                      <Users size={13} className="text-gray-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm truncate ${filterList === l.id ? 'font-semibold text-indigo-700' : 'text-gray-700'}`}>{l.name}</p>
                        <p className="text-[11px] text-gray-400">{l.contact_count.toLocaleString()} contactos</p>
                      </div>
                      {filterList === l.id && <Filter size={11} className="text-indigo-500 shrink-0" />}
                      <button
                        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 hover:text-teal-500 p-0.5 rounded"
                        title="Descargar lista"
                        onClick={e => { e.stopPropagation(); setDownloadList(l); setShowListsMenu(false) }}
                      >
                        <Download size={13} />
                      </button>
                      <button
                        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 hover:text-indigo-500 p-0.5 rounded"
                        title="Dividir lista"
                        onClick={e => { e.stopPropagation(); openSplitModal(l) }}
                      >
                        <Scissors size={13} />
                      </button>
                      <button
                        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 hover:text-red-500 p-0.5 rounded"
                        title="Eliminar lista"
                        disabled={deletingListId === l.id}
                        onClick={e => { e.stopPropagation(); deleteList(l.id, l.name) }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                  {currentUser?.role === 'admin' && (
                    <div className="border-t border-gray-100 px-3 py-2 mt-1">
                      <button
                        className="text-xs text-violet-600 hover:text-violet-800 font-medium flex items-center gap-1 disabled:opacity-50"
                        disabled={repopulating}
                        onClick={() => { repopularListas(); setShowListsMenu(false) }}
                      >
                        <DatabaseZap size={12} /> {repopulating ? 'Repoblando…' : 'Repoblar listas casino'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <Button size="sm" variant="outline" onClick={() => { setListMode('selection'); setShowList(true) }}
              className="border-indigo-200 text-indigo-700">
              <List size={14} className="mr-1" /> Lista por selección
            </Button>
            {canCreateContacts && (
              <Button size="sm" onClick={() => setShowAdd(true)} className="bg-green-600 hover:bg-green-700 text-white">
                <UserPlus size={14} className="mr-1" /> Nuevo contacto
              </Button>
            )}
            {canCreateContacts && (
              <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-input rounded-md bg-background hover:bg-muted transition-colors font-medium">
                <Upload size={14} /> Importar
                <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,.vcf" className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) { handleFile(f); setShowImport(true); e.target.value = '' } }} />
              </label>
            )}
          </>
        }
      />

      {/* Errores inline */}
      {loadError && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-2 text-sm text-destructive flex items-center justify-between">
          <span>Error al cargar contactos: {loadError}</span>
          <button onClick={() => setLoadError(null)} className="ml-4 opacity-60 hover:opacity-100">✕</button>
        </div>
      )}
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
        {/* Multi-select de nivel/segmentación */}
        <div className="relative" ref={segmentDropdownRef} onMouseLeave={() => setSegmentDropdownOpen(false)}>
          <button
            onClick={() => setSegmentDropdownOpen(o => !o)}
            className={`flex items-center gap-1.5 h-9 px-3 rounded-md border text-sm font-normal transition-colors
              ${segments.length > 0
                ? 'border-primary bg-primary/5 text-primary'
                : 'border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              }`}
          >
            {segments.length === 0
              ? 'Nivel'
              : segments.length === 1
                ? NIVEL_LABEL[segments[0]] ?? segments[0]
                : `${segments.length} niveles`
            }
            <ChevronDown size={14} className={`transition-transform ${segmentDropdownOpen ? 'rotate-180' : ''}`} />
          </button>
          {segmentDropdownOpen && (
            <div className="absolute z-50 top-full right-0 w-52 pt-1">
            <div className="rounded-md border bg-popover shadow-md p-1">
              {segments.length > 0 && (
                <button
                  className="w-full text-left text-xs px-2 py-1.5 text-muted-foreground hover:bg-accent rounded-sm mb-0.5"
                  onClick={() => { setSegments([]); resetPage() }}
                >
                  Limpiar selección
                </button>
              )}
              {(Object.keys(NIVEL_DESC) as string[]).map(v => (
                <label
                  key={v}
                  className="flex items-center gap-2.5 px-2 py-1.5 rounded-sm hover:bg-accent cursor-pointer text-sm"
                >
                  <Checkbox
                    checked={segments.includes(v)}
                    onCheckedChange={checked => {
                      setSegments(prev => {
                        const next = checked ? [...prev, v] : prev.filter(s => s !== v)
                        return next
                      })
                      resetPage()
                    }}
                  />
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${SEGMENT_STYLE[v] ?? 'bg-gray-100 text-gray-600'}`}>
                    {NIVEL_LABEL[v] ?? v}
                  </span>
                </label>
              ))}
            </div>
            </div>
          )}
        </div>
      </div>

      {/* Filtros — fila 2: dimensiones casino */}
      <div className="flex gap-3 flex-wrap items-center">
        {/* Multi-select Actividad */}
        <div className="relative" ref={actividadRef} onMouseLeave={() => setActividadOpen(false)}>
          <button
            onClick={() => setActividadOpen(o => !o)}
            className={`flex items-center gap-1.5 h-9 px-3 rounded-md border text-sm font-normal transition-colors
              ${filterActividad.length > 0
                ? 'border-primary bg-primary/5 text-primary'
                : 'border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              }`}
          >
            {filterActividad.length === 0
              ? 'Actividad'
              : filterActividad.length === 1
                ? filterActividad[0].replace('_', ' ')
                : `${filterActividad.length} actividades`
            }
            <ChevronDown size={14} className={`transition-transform ${actividadOpen ? 'rotate-180' : ''}`} />
          </button>
          {actividadOpen && (
            <div className="absolute z-50 top-full left-0 w-52 pt-1">
            <div className="rounded-md border bg-popover shadow-md p-1">
              {filterActividad.length > 0 && (
                <button className="w-full text-left text-xs px-2 py-1.5 text-muted-foreground hover:bg-accent rounded-sm mb-0.5"
                  onClick={() => { setFilterActividad([]); resetPage() }}>
                  Limpiar selección
                </button>
              )}
              {(Object.keys(ACTIVIDAD_DESC) as string[]).map(v => (
                <label key={v} title={ACTIVIDAD_DESC[v]} className="flex items-center gap-2.5 px-2 py-1.5 rounded-sm hover:bg-accent cursor-pointer text-sm">
                  <Checkbox
                    checked={filterActividad.includes(v)}
                    onCheckedChange={checked => {
                      setFilterActividad(prev => checked ? [...prev, v] : prev.filter(s => s !== v))
                      resetPage()
                    }}
                  />
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${ACTIVIDAD_STYLE[v] ?? 'bg-gray-100 text-gray-600'}`}>
                    {v.replace('_', ' ')}
                  </span>
                </label>
              ))}
            </div>
            </div>
          )}
        </div>

        {/* Multi-select Antigüedad */}
        <div className="relative" ref={antiguedadRef} onMouseLeave={() => setAntiguedadOpen(false)}>
          <button
            onClick={() => setAntiguedadOpen(o => !o)}
            className={`flex items-center gap-1.5 h-9 px-3 rounded-md border text-sm font-normal transition-colors
              ${filterAntiguedad.length > 0
                ? 'border-primary bg-primary/5 text-primary'
                : 'border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              }`}
          >
            {filterAntiguedad.length === 0
              ? 'Antigüedad'
              : filterAntiguedad.length === 1
                ? filterAntiguedad[0]
                : `${filterAntiguedad.length} antigüedades`
            }
            <ChevronDown size={14} className={`transition-transform ${antiguedadOpen ? 'rotate-180' : ''}`} />
          </button>
          {antiguedadOpen && (
            <div className="absolute z-50 top-full left-0 w-52 pt-1">
            <div className="rounded-md border bg-popover shadow-md p-1">
              {filterAntiguedad.length > 0 && (
                <button className="w-full text-left text-xs px-2 py-1.5 text-muted-foreground hover:bg-accent rounded-sm mb-0.5"
                  onClick={() => { setFilterAntiguedad([]); resetPage() }}>
                  Limpiar selección
                </button>
              )}
              {(Object.keys(ANTIGUEDAD_DESC) as string[]).map(v => (
                <label key={v} className="flex items-center gap-2.5 px-2 py-1.5 rounded-sm hover:bg-accent cursor-pointer text-sm">
                  <Checkbox
                    checked={filterAntiguedad.includes(v)}
                    onCheckedChange={checked => {
                      setFilterAntiguedad(prev => checked ? [...prev, v] : prev.filter(s => s !== v))
                      resetPage()
                    }}
                  />
                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-700">{v}</span>
                </label>
              ))}
            </div>
            </div>
          )}
        </div>

        {(filterActividad.length > 0 || filterAntiguedad.length > 0) && (
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground h-8 px-2"
            onClick={() => { setFilterActividad([]); setFilterAntiguedad([]); resetPage() }}>
            <X size={13} className="mr-1" /> Limpiar casino
          </Button>
        )}

        {/* ── Filtro plataforma ── */}
        <div className="flex items-center gap-1 border rounded-lg p-0.5 bg-muted/40">
          {(['', 'zeus', 'bet30', 'otros'] as const).map(v => (
            <button
              key={v || 'all'}
              onClick={() => { setFilterPlataforma(v); resetPage() }}
              className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors ${
                filterPlataforma === v
                  ? v === 'zeus'  ? 'bg-blue-600 text-white shadow-sm'
                  : v === 'bet30' ? 'bg-orange-500 text-white shadow-sm'
                  : v === 'otros' ? 'bg-gray-600 text-white shadow-sm'
                  : 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {v === '' ? 'Todos' : v === 'zeus' ? 'Zeus' : v === 'bet30' ? 'Bet30' : 'Otros'}
            </button>
          ))}
        </div>

        {/* ── Sin movimiento (12+ meses) ── */}
        <button
          onClick={() => { setFilterSinMovimiento(v => !v); resetPage() }}
          className={`text-xs px-2.5 py-1 rounded-md font-medium border transition-colors ${
            filterSinMovimiento
              ? 'bg-zinc-800 text-white border-zinc-800'
              : 'border-zinc-300 text-zinc-500 hover:border-zinc-500 hover:text-zinc-700'
          }`}
        >
          Sin movimiento
        </button>

        {/* ── Filtro por etiqueta ── */}
        <div className="relative">
          <Tag size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Etiqueta…"
            value={filterTag}
            onChange={e => { setFilterTag(e.target.value.toLowerCase()); resetPage() }}
            className="pl-7 h-8 text-xs w-36"
          />
          {filterTag && (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => { setFilterTag(''); resetPage() }}
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Badge de lista activa */}
      {filterList && (() => {
        const active = lists.find(l => l.id === filterList)
        return active ? (
          <div className="flex items-center gap-2 text-xs text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-1.5">
            <Filter size={12} /> Mostrando lista: <span className="font-semibold">{active.name}</span>
            <span className="text-indigo-400">({active.contact_count.toLocaleString()} contactos)</span>
            <button onClick={() => { setFilterList(''); resetPage() }} className="ml-1 text-indigo-400 hover:text-indigo-700">
              <X size={12} />
            </button>
          </div>
        ) : null
      })()}

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
              onClick={blacklistSelected}
              disabled={blacklistSaving}
              className="h-7 text-xs border-orange-200 text-orange-700 hover:bg-orange-50">
              <Ban size={13} className="mr-1" /> Blacklist ({ids.length})
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
        if (!v) { setImportRows([]); setImportResult(null); setImporting(false); setImportError(null); setImportPanel(''); setImportPanel2(''); setImportLinea(''); setImportCheck(null); setConflictMode('update') }
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
              <Button className="w-full" onClick={() => { setShowImport(false); setImportRows([]); setImportResult(null); setImportPanel(''); setImportPanel2(''); setImportLinea('') }}>Cerrar</Button>
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
              {/* Panel de conflictos */}
              {checkLoading && (
                <p className="text-xs text-muted-foreground">Verificando contactos existentes…</p>
              )}
              {!checkLoading && importCheck && importCheck.total > 0 && (
                <div className="border border-amber-200 bg-amber-50 rounded-lg p-3 space-y-2">
                  <p className="text-sm font-medium text-amber-800">
                    ⚠️ {importCheck.total.toLocaleString()} contactos ya existen en la base de datos
                  </p>
                  <div className="text-xs text-amber-700 space-y-0.5">
                    {Object.entries(importCheck.by_panel).map(([panel, count]) => (
                      <div key={panel} className="flex justify-between">
                        <span>{panel}</span>
                        <span className="font-medium">{count.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-col gap-1.5 pt-1">
                    <label className="flex items-center gap-2 cursor-pointer text-sm">
                      <input type="radio" checked={conflictMode === 'update'} onChange={() => setConflictMode('update')} className="accent-amber-600" />
                      <span>Actualizar existentes (nombre, nivel, agente, línea)</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer text-sm">
                      <input type="radio" checked={conflictMode === 'panels_only'} onChange={() => setConflictMode('panels_only')} className="accent-amber-600" />
                      <span className="font-medium text-blue-700">Solo agregar agente y línea — no toca nombre ni nivel</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer text-sm">
                      <input type="radio" checked={conflictMode === 'skip'} onChange={() => setConflictMode('skip')} className="accent-amber-600" />
                      <span>Omitir existentes (solo importa nuevos)</span>
                    </label>
                  </div>
                </div>
              )}
              {!checkLoading && importCheck && importCheck.total === 0 && (
                <p className="text-xs text-emerald-600">✓ Todos los contactos son nuevos</p>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Agente 1</label>
                  <Select value={importPanel || 'none'} onValueChange={v => setImportPanel(v === 'none' ? '' : (v ?? ''))}>
                    <SelectTrigger><SelectValue placeholder="Sin asignar" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Sin asignar</SelectItem>
                      {PANEL_OPTIONS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Agente 2 <span className="text-muted-foreground/60">(opcional)</span></label>
                  <Select value={importPanel2 || 'none'} onValueChange={v => setImportPanel2(v === 'none' ? '' : (v ?? ''))}>
                    <SelectTrigger><SelectValue placeholder="Sin asignar" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Sin asignar</SelectItem>
                      {PANEL_OPTIONS.filter(p => p !== importPanel).map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
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
              {importing && (
                <div className="space-y-1">
                  <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                    <div className="bg-green-500 h-2 rounded-full transition-all duration-300" style={{ width: `${importProgress}%` }} />
                  </div>
                  <p className="text-xs text-muted-foreground text-center">{importProgress}% — procesando {importRows.length.toLocaleString()} contactos…</p>
                </div>
              )}
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setShowImport(false)} disabled={importing}>Cancelar</Button>
                <Button className="flex-1 bg-green-600 hover:bg-green-700" onClick={confirmImport} disabled={importing}>
                  {importing ? `Importando… ${importProgress}%` : `Importar ${importRows.length.toLocaleString()} contactos`}
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
                    { label: 'Nivel', value: criteriaSegment, set: setCriteriaSegment, key: 'all-seg', items: [{ v: 'super_vip', l: 'Super Vip' }, { v: 'vip_alto', l: 'Vip Alto' }, { v: 'vip_medio', l: 'Vip Medio' }, { v: 'vip', l: 'Vip Bajo' }, { v: 'medio', l: 'Medio' }, { v: 'bajo', l: 'Bajo' }] },
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
                    { label: 'Actividad',  value: criteriaActividad,  set: setCriteriaActividad,  key: 'all-act', desc: ACTIVIDAD_DESC  as Record<string,string> },
                    { label: 'Antigüedad', value: criteriaAntiguedad, set: setCriteriaAntiguedad, key: 'all-ant', desc: ANTIGUEDAD_DESC as Record<string,string> },
                  ].map(({ label, value, set, key, desc }) => (
                    <div key={key}>
                      <label className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
                      <Select value={value || 'all'} onValueChange={v => set(v === 'all' ? '' : (v ?? ''))}>
                        <SelectTrigger><SelectValue placeholder={`Cualquier ${label.toLowerCase()}`} /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Cualquier {label.toLowerCase()}</SelectItem>
                          {Object.keys(desc).map(v => (
                            <SegmentItem key={v} value={v} label={v.replace('_', ' ')} desc={desc[v]} />
                          ))}
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
                { label: 'Nivel', value: newSegment, set: setNewSegment, items: [{ v: 'super_vip', l: 'Super Vip' }, { v: 'vip_alto', l: 'Vip Alto' }, { v: 'vip_medio', l: 'Vip Medio' }, { v: 'vip', l: 'Vip Bajo' }, { v: 'medio', l: 'Medio' }, { v: 'bajo', l: 'Bajo' }], ph: 'Nivel' },
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
      {/* ── Modal ver contacto ── */}
      <Dialog open={!!viewContact} onOpenChange={v => { if (!v) setViewContact(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">
              {viewContact ? `${viewContact.first_name || ''} ${viewContact.last_name || ''}`.trim() || viewContact.phone_number : ''}
            </DialogTitle>
          </DialogHeader>
          {viewContact && (
            <div className="space-y-3">
              <p className="font-mono text-sm text-muted-foreground">{viewContact.phone_number}</p>
              <div className="flex flex-wrap gap-1.5">
                {viewContact.segment  && <span className={`text-xs px-2 py-0.5 rounded-full ${SEGMENT_STYLE[viewContact.segment] ?? 'bg-gray-100 text-gray-600'}`}>{NIVEL_LABEL[viewContact.segment] ?? viewContact.segment}</span>}
                {viewContact.gaming   && <span className={`text-xs px-2 py-0.5 rounded-full ${GAMING_STYLE[viewContact.gaming] ?? 'bg-gray-100 text-gray-600'}`}>{viewContact.gaming}</span>}
                {viewContact.actividad && <span className={`text-xs px-2 py-0.5 rounded-full ${ACTIVIDAD_STYLE[viewContact.actividad] ?? 'bg-gray-100 text-gray-600'}`}>{viewContact.actividad}</span>}
                {viewContact.antiguedad && <span className={`text-xs px-2 py-0.5 rounded-full ${ANTIGUEDAD_STYLE[viewContact.antiguedad] ?? 'bg-gray-100 text-gray-600'}`}>{viewContact.antiguedad}</span>}
              </div>
              {/* Cuentas de casino por agente */}
              {(viewContact.casino_accounts?.length ?? 0) > 0 && (
                <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 space-y-1">
                  <p className="text-[10px] font-semibold text-blue-500 uppercase tracking-wide">Usuarios de casino</p>
                  {viewContact.casino_accounts!.map((acc, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <span className="text-xs text-gray-500 capitalize">{acc.panel}</span>
                      <span className="text-xs font-mono font-medium text-gray-800">{acc.username}</span>
                    </div>
                  ))}
                </div>
              )}
              {/* Zeus stats (or primary platform when contact has only one) */}
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    {casinoStats?.bet30 ? 'Zeus' : 'Historial del jugador'}
                  </p>
                  {casinoStats && (
                    <span className="text-[10px] text-gray-400 bg-white border border-gray-200 rounded px-1.5 py-0.5">
                      {casinoStats.mes_referencia ?? 'Histórico total'}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div>
                    <p className="text-xl font-bold text-gray-900">
                      {casinoStats
                        ? `$${casinoStats.monto_cargas_mes.toLocaleString('es-AR')}`
                        : <span className="text-gray-300 text-sm">…</span>}
                    </p>
                    <p className="text-[10px] text-gray-500">{casinoStats?.fuente === 'historico' ? 'Cargas total' : 'Cargas'}</p>
                  </div>
                  <div>
                    <p className="text-xl font-bold text-gray-900">
                      {casinoStats
                        ? `$${casinoStats.monto_retiros_mes.toLocaleString('es-AR')}`
                        : <span className="text-gray-300 text-sm">…</span>}
                    </p>
                    <p className="text-[10px] text-gray-500">Retiros</p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-700">
                      {casinoStats
                        ? (casinoStats.last_deposit_at
                            ? new Date(casinoStats.last_deposit_at).toLocaleDateString('es-AR')
                            : '—')
                        : <span className="text-gray-300">…</span>}
                    </p>
                    <p className="text-[10px] text-gray-500">Última carga</p>
                  </div>
                </div>
              </div>

              {/* Bet30 stats — solo visible cuando el contacto tiene ambas plataformas */}
              {casinoStats?.bet30 && (
                <div className="rounded-lg border border-orange-200 bg-orange-50 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-orange-600 uppercase tracking-wide">Bet30</p>
                    <span className="text-[10px] text-gray-400 bg-white border border-gray-200 rounded px-1.5 py-0.5">
                      {casinoStats.bet30.mes_referencia ?? 'Histórico total'}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div>
                      <p className="text-xl font-bold text-gray-900">
                        ${casinoStats.bet30.monto_cargas_mes.toLocaleString('es-AR')}
                      </p>
                      <p className="text-[10px] text-gray-500">{casinoStats.bet30.fuente === 'historico' ? 'Cargas total' : 'Cargas'}</p>
                    </div>
                    <div>
                      <p className="text-xl font-bold text-gray-900">
                        ${casinoStats.bet30.monto_retiros_mes.toLocaleString('es-AR')}
                      </p>
                      <p className="text-[10px] text-gray-500">Retiros</p>
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-gray-700">
                        {casinoStats.bet30.last_deposit_at
                          ? new Date(casinoStats.bet30.last_deposit_at).toLocaleDateString('es-AR')
                          : '—'}
                      </p>
                      <p className="text-[10px] text-gray-500">Última carga</p>
                    </div>
                  </div>
                </div>
              )}
              {/* Tags del contacto */}
              {(viewContact.custom_tags?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-1">
                  {viewContact.custom_tags!.map(t => (
                    <span key={t} className="text-xs bg-indigo-50 border border-indigo-200 text-indigo-700 px-2 py-0.5 rounded-full">{t}</span>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="flex-1" onClick={() => { setViewContact(null); openEdit(viewContact) }}>
                  <Pencil size={13} className="mr-1.5" /> Editar
                </Button>
                <Button variant="outline" size="sm" className="flex-1" onClick={() => { setViewContact(null); openTags(viewContact) }}>
                  <Tag size={13} className="mr-1.5" /> Etiquetas
                </Button>
                <Button variant="outline" size="sm"
                  className="border-orange-200 text-orange-700 hover:bg-orange-50"
                  onClick={() => blacklistContact(viewContact)}
                  disabled={blacklistSaving}
                >
                  <Ban size={13} />
                </Button>
              </div>
            </div>
          )}
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
                { label: 'Nivel',  value: editSegment, set: setEditSegment, items: [{ v: 'super_vip', l: 'Super Vip' }, { v: 'vip_alto', l: 'Vip Alto' }, { v: 'vip_medio', l: 'Vip Medio' }, { v: 'vip', l: 'Vip Bajo' }, { v: 'medio', l: 'Medio' }, { v: 'bajo', l: 'Bajo' }], ph: 'Nivel' },
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
            {/* Información financiera del jugador */}
            {editContact && (editContact.total_deposits !== undefined || editContact.last_deposit_at) && (
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Historial del jugador</p>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div>
                    <p className="text-lg font-bold text-gray-900">{editContact.total_deposits ?? 0}</p>
                    <p className="text-[10px] text-gray-500">Cargas (mes)</p>
                  </div>
                  <div>
                    <p className="text-lg font-bold text-gray-900">{editContact.total_withdrawals ?? 0}</p>
                    <p className="text-[10px] text-gray-500">Retiros (mes)</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-700">
                      {editContact.last_deposit_at
                        ? new Date(editContact.last_deposit_at).toLocaleDateString('es-AR')
                        : '—'}
                    </p>
                    <p className="text-[10px] text-gray-500">Última carga</p>
                  </div>
                </div>
                {editContact.total_deposits === 1 && editContact.last_deposit_at &&
                  (Date.now() - new Date(editContact.last_deposit_at).getTime()) > 10 * 24 * 60 * 60 * 1000 && (
                  <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 text-center">
                    Solo 1 depósito — más de 10 días desde la primera carga
                  </p>
                )}
              </div>
            )}

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

      {/* ── Modal etiquetas ── */}
      <Dialog open={!!tagsContact} onOpenChange={v => { if (!v) setTagsContact(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Tag size={16} /> Etiquetas</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {tagsContact ? `${tagsContact.first_name || tagsContact.phone_number}` : ''}
            </p>
            {/* Chips actuales */}
            <div className="flex flex-wrap gap-1.5 min-h-[32px]">
              {tagsValue.map(t => (
                <span key={t} className="inline-flex items-center gap-1 text-xs bg-indigo-50 border border-indigo-200 text-indigo-700 px-2 py-0.5 rounded-full">
                  {t}
                  <button type="button" onClick={() => removeTag(t)} className="hover:text-indigo-900 ml-0.5">
                    <X size={10} />
                  </button>
                </span>
              ))}
              {tagsValue.length === 0 && (
                <span className="text-xs text-muted-foreground italic">Sin etiquetas</span>
              )}
            </div>
            {/* Input para agregar */}
            <div className="flex gap-2">
              <input
                type="text"
                className="flex-1 text-sm border border-input rounded-md px-3 py-1.5 bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="Nueva etiqueta…"
                value={tagsInput}
                onChange={e => setTagsInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
                maxLength={50}
              />
              <Button size="sm" variant="outline" onClick={addTag} disabled={!tagsInput.trim()}>
                Agregar
              </Button>
            </div>
            {tagsError && <p className="text-xs text-destructive">{tagsError}</p>}
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setTagsContact(null)} disabled={tagsSaving}>
                Cancelar
              </Button>
              <Button className="flex-1" onClick={saveTags} disabled={tagsSaving}>
                {tagsSaving ? 'Guardando…' : 'Guardar etiquetas'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal de descarga global (contactos con filtros activos) */}
      <DownloadContactsModal
        open={showDownloadModal}
        onClose={() => setShowDownloadModal(false)}
        contactCount={total}
        fetchParams={buildDownloadParams()}
        filenameHint={buildFilterStr()}
      />

      {/* Modal de descarga de lista específica */}
      {downloadList && (
        <DownloadContactsModal
          open={!!downloadList}
          onClose={() => setDownloadList(null)}
          contactCount={downloadList.contact_count}
          fetchParams={new URLSearchParams({ list_id: downloadList.id })}
          filenameHint={`lista-${downloadList.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')}`}
        />
      )}

      {/* Modal dividir lista */}
      <Dialog open={!!splitSource} onOpenChange={open => { if (!open) { setSplitSource(null); setSplitResult(null) } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Scissors size={16} className="text-indigo-600" />
              Dividir lista
            </DialogTitle>
          </DialogHeader>

          {splitResult ? (
            <div className="space-y-3">
              <p className="text-sm text-gray-600">Las listas fueron creadas correctamente:</p>
              <div className="space-y-2">
                {splitResult.map((l, i) => (
                  <div key={l.id} className="flex items-center gap-2 bg-indigo-50 rounded-lg px-3 py-2">
                    <span className="text-xs font-semibold text-indigo-700 w-5">{i + 1}.</span>
                    <span className="text-sm font-medium text-indigo-900 flex-1 truncate">{l.name}</span>
                    <span className="text-xs text-indigo-500 shrink-0">{l.total.toLocaleString()} contactos</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-400">La lista original no fue modificada.</p>
              <div className="flex justify-end">
                <Button size="sm" onClick={() => { setSplitSource(null); setSplitResult(null) }}>Listo</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <p className="text-sm text-gray-600 mb-1">
                  Dividir <span className="font-semibold">"{splitSource?.name}"</span>{' '}
                  ({splitSource?.contact_count.toLocaleString()} contactos) en:
                </p>
                <div className="flex gap-2">
                  {([2, 3] as const).map(p => (
                    <button
                      key={p}
                      onClick={() => handleSplitPartsChange(p, splitSource?.name ?? '')}
                      className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-colors ${
                        splitParts === p
                          ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                          : 'border-gray-200 text-gray-600 hover:border-indigo-300'
                      }`}
                    >
                      {p} partes
                      {splitSource && (
                        <span className="block text-xs font-normal text-current opacity-70">
                          ~{Math.floor(splitSource.contact_count / p).toLocaleString()} c/u
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Nombres de las partes</p>
                {splitNames.map((name, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-xs text-gray-400 w-5 text-right">{i + 1}.</span>
                    <Input
                      value={name}
                      onChange={e => setSplitNames(prev => prev.map((n, idx) => idx === i ? e.target.value : n))}
                      placeholder={`Nombre parte ${i + 1}`}
                      className="text-sm h-8"
                    />
                  </div>
                ))}
              </div>

              {splitError && <p className="text-xs text-red-500">{splitError}</p>}

              <p className="text-xs text-gray-400">
                Los contactos se distribuyen aleatoriamente. La lista original no se modifica.
              </p>

              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => setSplitSource(null)}>Cancelar</Button>
                <Button
                  size="sm"
                  onClick={doSplit}
                  disabled={splittingList || splitNames.some(n => !n.trim())}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white"
                >
                  {splittingList ? 'Dividiendo…' : `Crear ${splitParts} listas`}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      </> /* fin activeTab === 'contacts' */}
    </div>
  )
}
