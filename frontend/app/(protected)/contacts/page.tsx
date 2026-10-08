'use client'
import { SegmentationDetails } from '@/components/contacts/SegmentationDetails'
import { QUALITY_LABELS, type SegmentationProfile } from '@/lib/contact-segmentation'
import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import dynamic from 'next/dynamic'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Search, Upload, RefreshCw, List, CheckSquare, X, Users, UserPlus,
  Trash2, Download, DatabaseZap, Pencil, ChevronDown, Filter, Info, Scissors,
  Tag, Ban, ChevronLeft, ChevronRight, Compass,
} from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'
import { deleteContacts } from '@/lib/delete-contacts'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { BroadcastFilter } from '@/components/contacts/BroadcastFilter'
import { EMPTY_BROADCAST, broadcastParams, broadcastLabel } from '@/lib/broadcast-range'
import { MovementRangeFilters } from '@/components/contacts/InactivityRangeFilter'
import { EMPTY_INACTIVITY, inactivityParams, inactivityLabel, type InactivityRange } from '@/lib/inactivity-range'
import { DownloadContactsModal } from '@/components/contacts/DownloadContactsModal'
import { SavedContactViews, CONTACT_COLUMNS, DEFAULT_CONTACT_VIEW, type ContactViewState } from '@/components/contacts/SavedContactViews'
import { ContactMessages } from '@/components/contacts/ContactMessages'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { PageHeader } from '@/components/layout/PageHeader'
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

const tabLoading = () => <p role="status" className="py-6 text-sm text-muted-foreground">Cargando…</p>
const ProspectsTab = dynamic(() => import('@/components/prospects/ProspectsTab').then(m => m.ProspectsTab), { loading: tabLoading })
const ProspectListsTab = dynamic(() => import('@/components/prospects/ProspectListsTab').then(m => m.ProspectListsTab), { loading: tabLoading })
const MissingPhoneTab = dynamic(() => import('@/components/contacts/MissingPhoneTab').then(m => m.MissingPhoneTab), { loading: tabLoading })

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

interface Contact {
  id: string; phone_number: string; first_name: string; last_name: string
  email: string; status: string; opt_in: boolean; created_at: string; segment: string; panel: string; gaming: string; linea: number | null; linea_sub: string | null
  segmentation_profile?: SegmentationProfile | null; data_quality?: string; segment_is_manual?: boolean
  actividad?: string; valor_riesgo?: string; antiguedad?: string
  last_deposit_at?: string | null; total_deposits?: number; total_withdrawals?: number
  platforms?: string[]; casino_accounts?: Array<{ panel: string; username: string }>; custom_tags?: string[]
}
interface ImportRow   { phone: string; name?: string; segment?: string }
interface ContactList { is_dynamic?: boolean; refreshed_at?: string; id: string; name: string; contact_count: number; created_at: string }

// ─────────────────────────────────────────────────────────────────────────────
// Constantes de dominio
// ─────────────────────────────────────────────────────────────────────────────

const PANEL_OPTIONS = ['betcoin', 'bigwin', 'farabet', 'ofizeus', 'royal', 'lasvegas']

// Sub-variantes de línea: permiten diferenciar una misma línea (ej. "Línea 9 a")
const LINEA_SUB_OPTIONS = [{ v: 'a', l: 'a' }, { v: 'b', l: 'b' }, { v: 'c', l: 'c' }]

const NIVEL_LABEL: Record<string, string> = {
  bajo: 'Bajo', medio: 'Medio', vip: 'Vip Bajo',
  vip_medio: 'Vip Medio', vip_alto: 'Vip Alto', super_vip: 'Super Vip',
}

const SEGMENT_STYLE: Record<string, string> = {
  casual: 'bg-muted text-muted-foreground', regular: 'bg-blue-100 text-blue-700',
  super_vip: 'bg-purple-100 text-purple-700', whale: 'bg-warning/15 text-warning',
  bajo: 'bg-orange-50 text-orange-700', medio: 'bg-muted text-slate-600',
  vip: 'bg-yellow-100 text-yellow-700',
  vip_medio: 'bg-orange-100 text-orange-700',
  vip_alto:  'bg-destructive/15 text-destructive',
}
const ACTIVIDAD_STYLE: Record<string, string> = {
  frecuente: 'bg-success/15 text-success', regular: 'bg-blue-100 text-blue-700',
  ocasional: 'bg-muted text-muted-foreground', nuevo: 'bg-cyan-100 text-cyan-700',
  en_riesgo: 'bg-orange-100 text-orange-700', inactivo: 'bg-destructive/15 text-destructive',
  perdido: 'bg-zinc-800 text-white',
}
const ACTIVIDAD_DESC: Record<string, string> = {
  frecuente: '≥ 3 cargas por semana en promedio',
  regular:   'Desde 1 y menos de 3 cargas por semana en promedio',
  ocasional: 'Menos de 1 carga por semana en promedio',
  nuevo:     'Primera carga hace hasta 30 días',
  en_riesgo: 'Última carga hace 31–60 días',
  inactivo:  'Última carga hace 61–180 días',
  perdido:   'Última carga hace más de 180 días',
}
const ANTIGUEDAD_DESC: Record<string, string> = {
  leal:        'Más de 9 meses como cliente',
  veterano:    'Entre 5 y 9 meses como cliente',
  establecido: 'Entre 3 y 5 meses como cliente',
  reciente:    'Entre 1 y 3 meses como cliente',
  nuevo:       'Menos de 1 mes como cliente',
}
const NIVEL_ORDER = ['super_vip','vip_alto','vip_medio','vip','medio','bajo']

const VALOR_RIESGO_STYLE: Record<string, string> = {
  critico: 'bg-destructive/15 text-destructive', medio: 'bg-orange-100 text-orange-700',
  bajo: 'bg-yellow-100 text-yellow-700',
}
const ANTIGUEDAD_STYLE: Record<string, string> = {
  nuevo: 'bg-sky-100 text-sky-600', reciente: 'bg-blue-100 text-blue-600',
  establecido: 'bg-accent text-primary', veterano: 'bg-violet-100 text-violet-700',
  leal: 'bg-purple-100 text-purple-700',
}
const GAMING_STYLE: Record<string, string> = {
  slots: 'bg-pink-100 text-pink-700', deportivas: 'bg-success/15 text-success',
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
  const [activeTab, setActiveTab] = useState<'contacts' | 'prospects' | 'prospect-lists' | 'missing-phone'>('contacts')

  // ── Datos ─────────────────────────────────────────────────────────────────
  const [contacts, setContacts] = useState<Contact[]>([])
  const [total, setTotal]       = useState(0)
  const [loading, setLoading]   = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // ── Filtros ───────────────────────────────────────────────────────────────
  const [filterRecent, setFilterRecent] = useState('')
  const [broadcast, setBroadcast] = useState(EMPTY_BROADCAST)
  const [dynamicList, setDynamicList] = useState(true)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [contactColumns, updateContactColumns] = useState<Record<string, boolean>>(CONTACT_COLUMNS)
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('contacts:cols') || 'null')
      if (saved && typeof saved === 'object' && !Array.isArray(saved) && Object.values(saved).every(value => typeof value === 'boolean')) {
        updateContactColumns(saved as Record<string, boolean>)
      }
    } catch { /* Keep default columns when browser storage is unavailable. */ }
  }, [])
  const setContactColumns = (columns: Record<string, boolean>) => {
    updateContactColumns(columns)
    try { localStorage.setItem('contacts:cols', JSON.stringify(columns)) } catch { /* The current view still works. */ }
  }
  const [detailTab, setDetailTab] = useState('resumen')
  const [search, setSearch]                   = useState('')
  const [segments, setSegments]               = useState<string[]>([])
  const [segmentDropdownOpen, setSegmentDropdownOpen] = useState(false)
  const segmentDropdownRef = useRef<HTMLDivElement>(null)
  const [filterGaming, setFilterGaming]       = useState('')
  const [filterPanel, setFilterPanel]         = useState('')
  const [filterLinea, setFilterLinea]         = useState('')
  const [filterLineaSub, setFilterLineaSub]   = useState('')
  const [inactivity, setInactivity] = useState<InactivityRange>(EMPTY_INACTIVITY)
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
  const selectedIds   = Object.keys(rowSelection).filter(id => rowSelection[id])
  const selectedPhones = useRef<Record<string, string>>({})
  const selectedCount = selectedIds.length



  // ── Listas ────────────────────────────────────────────────────────────────
  const [lists, setLists]             = useState<ContactList[]>([])
  const [filterList, setFilterList]   = useState('')
  const hasActiveFilters = !!(search || segments.length > 0 || filterGaming || filterPanel || filterLinea || filterLineaSub ||
    broadcast.mode || filterRecent || filterActividad.length > 0 || filterAntiguedad.length > 0 || filterPlataforma || filterSinMovimiento || filterTag || filterList || inactivity.min || inactivity.max)

  const [showListsMenu, setShowListsMenu] = useState(false)
  const [deletingListId, setDeletingListId] = useState<string | null>(null)
  const listsMenuRef = useRef<HTMLDivElement>(null)

  // ── Import modal ─────────────────────────────────────────────────────────
  const [showImport, setShowImport]     = useState(false)
  const [importRows, setImportRows]     = useState<ImportRow[]>([])
  const [importPanel, setImportPanel]   = useState('')
  const [importPanel2, setImportPanel2] = useState('')
  const [importLinea, setImportLinea]   = useState('')
  const [importLineaSub, setImportLineaSub] = useState('')
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
  const [newLineaSub, setNewLineaSub] = useState('')
  const [addError, setAddError]     = useState('')
  const [addSaving, setAddSaving]   = useState(false)

  // ── List modal ────────────────────────────────────────────────────────────
  const [showList, setShowList]               = useState(false)
  const [listMode, setListMode]               = useState<'selection' | 'criteria' | 'filters'>('selection')
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
  useEffect(() => {
    setViewContact(previous => previous ? contacts.find(contact => contact.id === previous.id) ?? previous : null)
  }, [contacts])
  const [viewContactIdx, setViewContactIdx] = useState<number>(-1)
  const [casinoStats, setCasinoStats] = useState<{ platforms: Array<{
    platform: string | null; monto_cargas_mes: number; monto_retiros_mes: number
    last_deposit_at: string | null; mes_referencia: string | null; fuente: 'transactions' | 'historico'
  }> } | null>(null)
  const [casinoStatsError, setCasinoStatsError] = useState<string | null>(null)
  const casinoStatsRequest = useRef(0)

  const openViewContact = (c: Contact) => {
    const request = ++casinoStatsRequest.current
    setViewContact(c)
    setCasinoStats(null)
    setCasinoStatsError(null)
    setViewContactIdx(contacts.findIndex(x => x.id === c.id))
    fetchJson<NonNullable<typeof casinoStats>>(`/api/contacts/${c.id}/casino-stats`)
      .then(d => { if (request === casinoStatsRequest.current) setCasinoStats(d) })
      .catch(() => { if (request === casinoStatsRequest.current) setCasinoStatsError('No se pudo cargar el historial') })
  }

  const goNextContact = () => {
    if (viewContactIdx >= 0 && viewContactIdx < contacts.length - 1)
      openViewContact(contacts[viewContactIdx + 1])
  }
  const goPrevContact = () => {
    if (viewContactIdx > 0)
      openViewContact(contacts[viewContactIdx - 1])
  }

  // ── Edit contact modal ────────────────────────────────────────────────────
  const [editContact, setEditContact]   = useState<Contact | null>(null)
  const [editFirstName, setEditFirstName] = useState('')
  const [editLastName, setEditLastName]   = useState('')
  const [editPanel, setEditPanel]         = useState('')
  const [editLinea, setEditLinea]         = useState('')
  const [editLineaSub, setEditLineaSub]   = useState('')
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

  // ── Confirmación bulk ─────────────────────────────────────────────────────
  const [confirmBulk, setConfirmBulk] = useState<{
    action: 'delete' | 'blacklist'
    mode: 'selection' | 'filters'
    count: number
    ids?: string[]
  } | null>(null)
  const [confirmExecuting, setConfirmExecuting] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null)
  const confirming = useRef(false)

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
  useEffect(() => {
    if (!canCreateContacts) return
    const open = () => { setActiveTab('contacts'); setShowAdd(true) }
    const url = new URL(window.location.href)
    if (url.searchParams.get('action') === 'new') {
      open(); url.searchParams.delete('action'); window.history.replaceState(null, '', url)
    }
    window.addEventListener('cmd:new-contact', open)
    return () => window.removeEventListener('cmd:new-contact', open)
  }, [canCreateContacts])


  // ── Carga de datos ────────────────────────────────────────────────────────

  const buildContactParams = useCallback(() => new URLSearchParams({
    q: search, segment: segments.join(','), gaming: filterGaming, panel: filterPanel.trim(),
    linea: filterLinea, actividad: filterActividad.join(','), antiguedad: filterAntiguedad.join(','),
    linea_sub: filterLineaSub, list_id: filterList, plataforma: filterPlataforma,
    sin_movimiento: String(filterSinMovimiento), tag: filterTag, depositos_recientes: filterRecent, ...inactivityParams(inactivity), ...broadcastParams(broadcast),
  }), [search, segments, filterGaming, filterPanel, filterLinea, filterActividad,
    filterAntiguedad, filterLineaSub, filterList, filterPlataforma, filterSinMovimiento, filterTag, inactivity, filterRecent, broadcast])

  const audienceKey = buildContactParams().toString()
  const activeAudience = useRef(audienceKey)
  activeAudience.current = audienceKey
  const contactLoadRequest = useRef(0)
  const loadRequest = useRef<AbortController | null>(null)
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const firstLoad = useRef(true)
  useEffect(() => {
    setRowSelection({})
    selectedPhones.current = {}
  }, [audienceKey])

  const load = useCallback(() => {
    if (loadTimer.current) clearTimeout(loadTimer.current)
    loadRequest.current?.abort()
    const controller = new AbortController()
    loadRequest.current = controller
    const request = ++contactLoadRequest.current
    setLoading(true)
    const q = buildContactParams()
    q.set('page', String(pagination.pageIndex + 1))
    setLoadError(null)
    fetchJson<{ contacts: Contact[]; total: number }>(`/api/contacts?${q}`, { signal: controller.signal })
      .then(d => {
        if (request !== contactLoadRequest.current) return
        for (const c of d.contacts || []) selectedPhones.current[c.id] = c.phone_number
        setContacts(d.contacts || []); setTotal(d.total || 0)
      })
      .catch((e: unknown) => {
        if (request !== contactLoadRequest.current || controller.signal.aborted) return
        setContacts([])
        setTotal(0)
        setLoadError(e instanceof Error ? e.message : 'Error al cargar contactos')
      })
      .finally(() => { if (request === contactLoadRequest.current) setLoading(false) })
  }, [buildContactParams, pagination.pageIndex])

  useEffect(() => {
    // Load the first page immediately; group rapid typing/filter edits into one
    // request. Cancellation alone cannot stop SQL already running on the server.
    setLoading(true)
    if (firstLoad.current) { firstLoad.current = false; load() }
    else loadTimer.current = setTimeout(load, 250)
    return () => {
      if (loadTimer.current) clearTimeout(loadTimer.current)
      ++contactLoadRequest.current
      loadRequest.current?.abort()
    }
  }, [load])
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
  const viewState: ContactViewState = {broadcast,quality:'',recent:filterRecent,search,segments,gaming:filterGaming,panel:filterPanel,linea:filterLinea,lineaSub:filterLineaSub,inactivity,actividad:filterActividad,antiguedad:filterAntiguedad,plataforma:filterPlataforma,sinMovimiento:filterSinMovimiento,tag:filterTag,list:filterList,columns:contactColumns}
  const applyView = (v: ContactViewState) => {
    setBroadcast(v.broadcast || EMPTY_BROADCAST);setFilterRecent(v.recent||'');setSearch(v.search);setSegments(v.segments);setFilterGaming(v.gaming);setFilterPanel(v.panel);setFilterLinea(v.linea);setFilterLineaSub(v.lineaSub);setInactivity(v.inactivity);setFilterActividad(v.actividad);setFilterAntiguedad(v.antiguedad);setFilterPlataforma(v.plataforma);setFilterSinMovimiento(v.sinMovimiento);setFilterTag(v.tag);setFilterList(v.list);setContactColumns(v.columns);setRowSelection({});resetPage()
  }
  const activeFilterLabels = [broadcast.mode&&broadcastLabel(broadcast),filterRecent&&`Depósitos ${filterRecent}d (último cálculo)`,search&&`Búsqueda: ${search}`,segments.length&&`Nivel: ${segments.map(v=>NIVEL_LABEL[v]||v).join(', ')}`,filterPanel&&`Agente: ${filterPanel}`,filterLinea&&`Línea: ${filterLinea}${filterLineaSub}`,!filterLinea&&filterLineaSub&&`Variante: ${filterLineaSub}`,filterGaming&&`Juego: ${filterGaming}`,filterPlataforma&&`Plataforma: ${filterPlataforma}`,filterActividad.length&&`Actividad: ${filterActividad.join(', ')}`,filterAntiguedad.length&&`Antigüedad: ${filterAntiguedad.join(', ')}`,(inactivity.min||inactivity.max)&&inactivityLabel(inactivity),filterSinMovimiento&&'12 meses sin depósitos registrados',filterTag&&`Etiqueta: ${filterTag}`,filterList&&`Lista: ${lists.find(l=>l.id===filterList)?.name||'seleccionada'}`].filter(Boolean)


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
      body: JSON.stringify({ phone: newPhone, name: newName, panel: newPanel, gaming: newGaming || null, segment: newSegment || null, linea: newLinea ? Number(newLinea) : null, linea_sub: newLinea ? (newLineaSub || null) : null }),
    })
    const data = await res.json()
    setAddSaving(false)
    if (!res.ok) { setAddError(data.error || 'Error al guardar'); return }
    setShowAdd(false); setNewPhone(''); setNewName(''); setNewPanel('')
    setNewGaming(''); setNewSegment(''); setNewLinea(''); setNewLineaSub(''); setAddError('')
    load()
  }

  const deleteContact = useCallback(async (id: string) => {
    if (!confirm('¿Eliminar este contacto?')) return
    const result = await deleteContacts([id])
    if (result.failed.length) {
      setUpdateError(result.failed[0].error)
      return
    }
    setUpdateError(null)
    setDeleteNotice('Contacto eliminado.')
    setContacts(prev => prev.filter(c => c.id !== id))
    setTotal(prev => prev - 1)
    setRowSelection(prev => { const n = { ...prev }; delete n[id]; return n })
  }, [])

  const deleteBulk = async (ids: string[]) => {
    const result = await deleteContacts(ids)
    const deleted = new Set(result.deleted)
    if (deleted.size > 0) {
      setContacts(prev => prev.filter(c => !deleted.has(c.id)))
      setTotal(prev => Math.max(0, prev - deleted.size))
      setRowSelection(prev => Object.fromEntries(Object.entries(prev).filter(([id]) => !deleted.has(id))))
      setDeleteNotice(`${deleted.size.toLocaleString()} contactos eliminados.`)
    }
    if (result.failed.length > 0) {
      const pendingIds = result.failed.map(item => item.id)
      setRowSelection(Object.fromEntries(pendingIds.map(id => [id, true])))
      // Retry only the failed IDs, including when the original request used filters.
      setConfirmBulk({ action: 'delete', mode: 'selection', count: pendingIds.length, ids: pendingIds })
      const errors = [...new Set(result.failed.map(item => item.error))].join(' ')
      throw new Error(`${deleted.size} eliminados. No se pudieron eliminar ${pendingIds.length} contactos. ${errors}`)
    }
  }

  const deleteSelected = async () => {
    setConfirmError(null)
    setDeleteNotice(null)
    if (selectedCount > 0) {
      setConfirmBulk({ action: 'delete', mode: 'selection', count: selectedCount, ids: [...selectedIds] })
    } else if (hasActiveFilters) {
      setConfirmBulk({ action: 'delete', mode: 'filters', count: total })
    }
  }

  const selectAllFiltered = async () => {
    const requestedAudience = audienceKey
    setSelectingAll(true)
    try {
      const q = buildContactParams()
      q.set('select_all', 'true')
      const d = await fetchJson<{ ids: string[]; phones: string[] }>(`/api/contacts?${q}`)
      if (activeAudience.current !== requestedAudience) return
      d.ids.forEach((id, i) => { selectedPhones.current[id] = d.phones[i] })
      const next: RowSelectionState = {}
      for (const id of d.ids || []) next[id] = true
      setRowSelection(next)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'No se pudo seleccionar la audiencia')
    } finally { setSelectingAll(false) }
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
    reader.onload = async (e) => {
      try {
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
        const XLSX = await import('xlsx')
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
      } catch {
        setImportRows([])
        setImportError('No se pudo leer el archivo. Volvé a seleccionarlo e intentá nuevamente.')
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
    const linea_sub = importLinea && importLineaSub ? importLineaSub : undefined
    const chunks: ImportRow[][] = []
    for (let i = 0; i < importRows.length; i += CHUNK_SIZE) chunks.push(importRows.slice(i, i + CHUNK_SIZE))

    let totalInserted = 0, totalUpdated = 0, totalSkipped = 0

    try {
      for (let i = 0; i < chunks.length; i++) {
        const res = await fetch('/api/contacts/import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contacts: chunks[i], panels, linea, linea_sub, conflict_mode: conflictMode }),
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
      (inactivity.min || inactivity.max) && `${inactivity.mode === 'period' ? 'con-movimientos' : 'inactividad'}-${inactivity.min || '0'}-${inactivity.max || 'sin-maximo'}`,
      filterPanel      && `panel-${filterPanel}`,
      filterGaming     && `juego-${filterGaming}`,
      segments.length  && `nivel-${segments.join('-')}`,
      search           && `busq-${search}`,
      filterActividad.length  && `actividad-${filterActividad.join('-')}`,
      filterAntiguedad.length && `antiguedad-${filterAntiguedad.join('-')}`,
    ].filter(Boolean).join('_') || 'todos'

  const buildDownloadParams = buildContactParams

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
    } else if (listMode === 'filters' && dynamicList) {
      body = {name:newListName,is_dynamic:true,filters:Object.fromEntries(buildContactParams())}
    } else if (listMode === 'filters') {
      try {
        const q = buildContactParams()
        q.set('select_all', 'true')
        const d = await fetchJson<{ ids: string[] }>(`/api/contacts?${q}`)
        body = { name: newListName, contact_ids: d.ids || [] }
      } catch (e) {
        setSavingList(false)
        setListError(e instanceof Error ? e.message : 'Error al obtener los contactos filtrados')
        return
      }
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
    setEditLineaSub(c.linea_sub || '')
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
      linea_sub:  editLinea  ? (editLineaSub || null) : null,
      ...(editSegment!==(editContact.segment||'') ? {segment:editSegment||null} : {}),
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
    setConfirmError(null)
    if (selectedCount > 0) {
      setConfirmBulk({ action: 'blacklist', mode: 'selection', count: selectedCount })
    } else if (hasActiveFilters) {
      setConfirmBulk({ action: 'blacklist', mode: 'filters', count: total })
    }
  }

  const executeConfirm = async () => {
    if (!confirmBulk || confirming.current) return
    confirming.current = true
    setConfirmExecuting(true)
    setConfirmError(null)
    try {
      if (confirmBulk.mode === 'selection') {
        if (confirmBulk.action === 'delete') {
          await deleteBulk(confirmBulk.ids ?? selectedIds)
        } else {
          const phones = selectedIds.map(id => selectedPhones.current[id]).filter(Boolean)
          if (phones.length !== selectedIds.length) throw new Error('No se pudieron recuperar todos los teléfonos seleccionados. Volvé a seleccionar los contactos.')
          await sendToBlacklist(phones, () => setRowSelection({}))
        }
      } else {
        // filters mode: fetch all matching IDs + phones first
        const q = buildContactParams()
        q.set('select_all', 'true')
        const d = await fetchJson<{ ids: string[]; phones: string[] }>(`/api/contacts?${q}`)
        if (confirmBulk.action === 'delete') {
          await deleteBulk(d.ids || [])
        } else {
          await sendToBlacklist(d.phones || [], () => setRowSelection({}))
        }
      }
      setConfirmBulk(null)
    } catch (e) {
      setConfirmError(e instanceof Error ? e.message : 'No se pudo procesar la selección. Volvé a intentar.')
    } finally {
      confirming.current = false
      setConfirmExecuting(false)
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
            <div className="flex flex-wrap items-center gap-1.5 min-w-0 md:flex-nowrap">
              <EditableTextCell
                className="min-w-0 break-words"
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
              {platforms.includes('ganamos') && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-success/15 text-success">Ganamos</span>}
              {platforms.includes('argenbet') && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-purple-100 text-purple-700">Argenbet</span>}
              {platforms.length === 0 && hasName && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-muted text-muted-foreground">otros</span>}
            </div>
            {customTags.length > 0 && (
              <div className="flex flex-wrap gap-1" onClick={e => e.stopPropagation()}>
                {customTags.map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => { setFilterTag(t); resetPage() }}
                    className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium border transition-colors cursor-pointer hover:bg-accent ${filterTag === t ? 'bg-indigo-200 border-indigo-400 text-accent-foreground' : 'bg-accent text-primary border-primary/20'}`}
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
          activeClass="bg-accent text-primary"
          placeholder="— sin agente"
          ariaLabel={`Editar Agente de ${row.original.first_name || row.original.phone_number}`}
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
        <div className="flex items-center gap-0.5">
          <EditableCell
            value={row.original.linea != null ? String(row.original.linea) : ''}
            options={Array.from({ length: 100 }, (_, i) => ({ value: String(i + 1), label: `Línea ${i + 1}` }))}
            activeClass="bg-orange-50 text-orange-700"
            placeholder="— sin línea"
            ariaLabel={`Editar Línea de ${row.original.first_name || row.original.phone_number}`}
          onChange={v => updateField(row.original.id, 'linea', v ? Number(v) : null)}
          />
          {row.original.linea != null && (
            <EditableCell
              value={row.original.linea_sub || ''}
              options={LINEA_SUB_OPTIONS.map(o => ({ value: o.v, label: o.l }))}
              activeClass="bg-orange-50 text-orange-700"
              placeholder="—"
              ariaLabel={`Editar Variante de línea de ${row.original.first_name || row.original.phone_number}`}
          onChange={v => updateField(row.original.id, 'linea_sub', v || null)}
            />
          )}
        </div>
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
          ariaLabel={`Editar Juego de ${row.original.first_name || row.original.phone_number}`}
          onChange={v => updateField(row.original.id, 'gaming', v || null)}
        />
      ),
      meta: { mobileLabel: 'Juego' },
    },
    {
      id: 'segment',
      accessorKey: 'segment',
      header: 'Nivel global',
      enableSorting: false,
      cell: ({ row }) => (
        <div className="space-y-1"><EditableCell
          value={row.original.segment || ''}
          options={[
            { value: 'super_vip', label: 'Super Vip' },
            { value: 'vip_alto',  label: 'Vip Alto' },
            { value: 'vip_medio', label: 'Vip Medio' },
            { value: 'vip',       label: 'Vip Bajo' },
            { value: 'medio',     label: 'Medio' },
            { value: 'bajo',      label: 'Bajo' },
          ]}
          activeClass={SEGMENT_STYLE[row.original.segment] ?? 'bg-muted text-muted-foreground'}
          placeholder="Sin nivel calculado"
          ariaLabel={`Editar Nivel de ${row.original.first_name || row.original.phone_number}`}
          onChange={v => updateField(row.original.id, 'segment', v || null)}
        /><p className="text-[10px] text-muted-foreground">{row.original.segment_is_manual?'Elección manual':QUALITY_LABELS[row.original.data_quality||'sin_datos']}</p></div>
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
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap bg-warning/15 text-warning border border-warning/20">
                1er dep. · 10d+
              </span>
            )}
            {c.valor_riesgo && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap ${VALOR_RIESGO_STYLE[c.valor_riesgo] ?? 'bg-muted text-muted-foreground'}`}>
                ⚠ {c.valor_riesgo}
              </span>
            )}
            {c.antiguedad && (
              <span className={`relative group text-[10px] px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap cursor-help ${ANTIGUEDAD_STYLE[c.antiguedad] ?? 'bg-muted text-muted-foreground'}`}>
                {c.antiguedad}
                <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 rounded bg-gray-800 text-white text-[11px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-100 z-50">
                  {ANTIGUEDAD_DESC[c.antiguedad]}
                </span>
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
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${ACTIVIDAD_STYLE[row.original.actividad] ?? 'bg-muted text-muted-foreground'}`}>
          {row.original.actividad}
        </span>
      ) : (
        <Badge variant={row.original.status === 'active' ? 'default' : 'secondary'}
               className={`text-xs ${row.original.status === 'active' ? 'bg-success/15 text-success' : ''}`}>
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
        <span className={`text-xs font-medium ${row.original.opt_in ? 'text-success' : 'text-muted-foreground/50'}`}>
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
      <div className="flex gap-1 overflow-x-auto border-b pb-0">
        <button
          onClick={() => setActiveTab('contacts')}
          className={`shrink-0 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'contacts'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          Contactos
        </button>
        <button
          onClick={() => setActiveTab('missing-phone')}
          className={`shrink-0 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'missing-phone' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          Usuarios sin número
        </button>
        <button
          onClick={() => setActiveTab('prospects')}
          className={`shrink-0 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'prospects'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          Base de Difusión
        </button>
        <button
          onClick={() => setActiveTab('prospect-lists')}
          className={`shrink-0 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'prospect-lists'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          Listas de Difusión
        </button>
      </div>

      {activeTab === 'prospects' && <ProspectsTab />}
      {activeTab === 'prospect-lists' && <ProspectListsTab />}
      {activeTab === 'missing-phone' && <MissingPhoneTab onImported={() => { void load() }} />}

      {activeTab === 'contacts' && <>
      <PageHeader
        title="Contactos"
        description="Tu base de clientes, organizada y siempre a mano."
        count={total}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load} aria-label="Actualizar contactos">
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </Button>

            {canCreateContacts && (
              <Button size="sm" onClick={() => setShowAdd(true)} className="bg-primary hover:bg-primary/90 text-primary-foreground">
                <UserPlus size={14} className="mr-1" /> Nuevo contacto
              </Button>
            )}
          </>
        }
      />

      <div
        role="group"
        aria-label="Herramientas de contactos"
        className="relative flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3"
      >
        {currentUser?.can_download_contacts && (
          <Button variant="outline" size="sm"
            onClick={() => setShowDownloadModal(true)}
            className="border-input text-foreground hover:bg-muted">
            <Download size={14} className="mr-1" /> Descargar
          </Button>
        )}

        <Button size="sm" variant="outline" onClick={selectAllFiltered} disabled={selectingAll}
          className="border-input text-foreground hover:bg-muted">
          <CheckSquare size={14} className="mr-1" />
          {selectingAll ? 'Seleccionando…' : 'Seleccionar todos'}
        </Button>
        {/* Botón Listas — dropdown con todas las listas */}
        <div className="static sm:relative" ref={listsMenuRef}>
          <Button
            size="sm" variant="outline"
            onClick={() => setShowListsMenu(v => !v)}
            className={`border-input text-foreground hover:bg-muted hover:bg-accent ${filterList ? 'bg-accent border-indigo-400' : ''}`}
          >
            <List size={14} className="mr-1" />
            {filterList ? (lists.find(l => l.id === filterList)?.name ?? 'Lista') : 'Listas'}
            {filterList && <X size={11} className="ml-1.5 opacity-60 hover:opacity-100" onClick={e => { e.stopPropagation(); setFilterList(''); resetPage() }} />}
            {!filterList && <ChevronDown size={12} className="ml-1 opacity-60" />}
          </Button>
          {showListsMenu && (
            <div className="absolute inset-x-3 top-full mt-1 bg-card border border-border rounded-xl shadow-lg z-30 py-1 max-h-80 overflow-y-auto sm:inset-x-auto sm:left-0 sm:w-72">
              <div className="px-3 py-2 border-b border-border flex items-center justify-between">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Mis listas</span>
                <button
                  className="text-xs text-primary hover:text-accent-foreground font-medium"
                  onClick={() => { setShowListsMenu(false); setListMode('criteria'); setShowList(true) }}
                >
                  + Nueva lista
                </button>
              </div>
              {lists.length === 0 && (
                <p className="text-xs text-muted-foreground px-3 py-4 text-center">No hay listas creadas</p>
              )}
              {lists.map(l => (
                <div
                  key={l.id}
                  className={`flex items-center gap-2 px-3 py-2.5 hover:bg-background cursor-pointer group ${filterList === l.id ? 'bg-accent' : ''}`}
                  onClick={() => { setFilterList(l.id); resetPage(); setShowListsMenu(false) }}
                >
                  <Users size={13} className="text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm truncate ${filterList === l.id ? 'font-semibold text-primary' : 'text-foreground'}`}>{l.name}</p>
                    <p className="text-[11px] text-muted-foreground">{l.contact_count.toLocaleString()} contactos · {l.is_dynamic ? "Dinámica · se actualiza al preparar cada campaña" : "Lista fija"}</p>
                  </div>
                  {filterList === l.id && <Filter size={11} className="text-indigo-500 shrink-0" />}
                  <button
                    className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/60 hover:text-teal-500 p-0.5 rounded"
                    title="Descargar lista"
                    onClick={e => { e.stopPropagation(); setDownloadList(l); setShowListsMenu(false) }}
                  >
                    <Download size={13} />
                  </button>
                  <button
                    className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/60 hover:text-indigo-500 p-0.5 rounded"
                    title="Dividir lista"
                    onClick={e => { e.stopPropagation(); openSplitModal(l) }}
                  >
                    <Scissors size={13} />
                  </button>
                  <button
                    className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/60 hover:text-red-500 p-0.5 rounded"
                    title="Eliminar lista"
                    disabled={deletingListId === l.id}
                    onClick={e => { e.stopPropagation(); deleteList(l.id, l.name) }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              {currentUser?.role === 'admin' && (
                <div className="border-t border-border px-3 py-2 mt-1">
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
        {contacts.length > 0 && (
          <Button size="sm" variant="outline"
            onClick={() => openViewContact(contacts[0])}
            className="border-input text-foreground hover:bg-muted">
            <Compass size={14} className="mr-1" /> Explorar
          </Button>
        )}
        {(selectedCount > 0 || hasActiveFilters) && (
          <>
            <Button size="sm" variant="outline"
              onClick={blacklistSelected}
              disabled={blacklistSaving}
              className="border-orange-200 text-orange-700 hover:bg-orange-50">
              <Ban size={14} className="mr-1" /> Blacklist ({selectedCount > 0 ? selectedCount : total.toLocaleString()})
            </Button>
            <Button size="sm" variant="outline"
              onClick={deleteSelected}
              className="border-destructive/30 text-destructive hover:bg-destructive/10">
              <Trash2 size={14} className="mr-1" /> Eliminar ({selectedCount > 0 ? selectedCount : total.toLocaleString()})
            </Button>
          </>
        )}
        {hasActiveFilters && (
          <Button size="sm" variant="outline"
            onClick={() => { setListMode('filters'); setShowList(true) }}
            className="border-input text-foreground hover:bg-muted">
            <List size={14} className="mr-1" /> Crear lista ({total.toLocaleString()})
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => { setListMode('selection'); setShowList(true) }}
          className="border-input text-foreground hover:bg-muted">
          <List size={14} className="mr-1" /> Lista por selección
        </Button>

        {canCreateContacts && (
          <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-input rounded-md bg-background hover:bg-muted transition-colors font-medium">
            <Upload size={14} /> Importar
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,.vcf" className="sr-only" aria-label="Importar contactos"
              onChange={e => { const f = e.target.files?.[0]; if (f) { handleFile(f); setShowImport(true); e.target.value = '' } }} />
          </label>
        )}
      </div>

      {/* Errores inline */}
      {loadError && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-2 text-sm text-destructive flex items-center justify-between">
          <span>Error al cargar contactos: {loadError}</span>
          <button onClick={() => setLoadError(null)} className="ml-4 opacity-60 hover:opacity-100">✕</button>
        </div>
      )}
      {deleteNotice && <p role="status" className="text-sm text-success">{deleteNotice}</p>}
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

      <SavedContactViews userId={currentUser?.id} state={viewState} onApply={applyView}/>
      {/* Filtros — fila 1 */}
      <div className="filter-bar">
        <div className="relative flex-1 min-w-48">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" aria-label="Buscar contactos" placeholder="Buscar por nombre o teléfono…" value={search}
            onChange={e => { setSearch(e.target.value); resetPage() }} />
        </div>
        <Button variant={filtersOpen?'secondary':'outline'} onClick={()=>setFiltersOpen(v=>!v)} aria-expanded={filtersOpen} aria-controls="contact-filters"><Filter size={14}/>Filtros{activeFilterLabels.length>0?` (${activeFilterLabels.length})`:''}</Button>
      </div>
      {activeFilterLabels.length>0&&<div className="flex flex-wrap items-center gap-1.5" aria-label="Filtros activos">{activeFilterLabels.map(label=><span key={String(label)} className="max-w-full break-words rounded-md border bg-muted/40 px-2 py-1 text-xs">{label}</span>)}<Button variant="ghost" size="sm" onClick={()=>applyView({...DEFAULT_CONTACT_VIEW,columns:contactColumns})}>Limpiar filtros</Button></div>}
      <div id="contact-filters" hidden={!filtersOpen} className="space-y-3 rounded-xl border bg-card p-3">
      <div className="flex flex-wrap gap-2">
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
        <Select value={filterLineaSub} onValueChange={v => { setFilterLineaSub(v ?? ''); resetPage() }}>
          <SelectTrigger className="w-24"><SelectValue placeholder="Var." /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">Todas</SelectItem>
            {LINEA_SUB_OPTIONS.map(o => <SelectItem key={o.v} value={o.v}>{o.l}</SelectItem>)}
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
              {NIVEL_ORDER.map(v => (
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
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${SEGMENT_STYLE[v] ?? 'bg-muted text-muted-foreground'}`}>
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
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${ACTIVIDAD_STYLE[v] ?? 'bg-muted text-muted-foreground'}`}>
                    {v.replace('_', ' ')}
                  </span>
                </label>
              ))}
            </div>
            </div>
          )}
        </div>

        <BroadcastFilter value={broadcast} onChange={value => { setBroadcast(value); setRowSelection({}); resetPage() }} />

        <MovementRangeFilters value={inactivity} onChange={range => {
          setInactivity(range); setRowSelection({}); resetPage()
        }} />

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
                <label key={v} title={ANTIGUEDAD_DESC[v]} className="flex items-center gap-2.5 px-2 py-1.5 rounded-sm hover:bg-accent cursor-pointer text-sm">
                  <Checkbox
                    checked={filterAntiguedad.includes(v)}
                    onCheckedChange={checked => {
                      setFilterAntiguedad(prev => checked ? [...prev, v] : prev.filter(s => s !== v))
                      resetPage()
                    }}
                  />
                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-muted text-foreground">{v}</span>
                </label>
              ))}
            </div>
            </div>
          )}
        </div>

        {(filterActividad.length > 0 || filterAntiguedad.length > 0 || inactivity.min !== '' || inactivity.max !== '') && (
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground h-8 px-2"
            onClick={() => { setFilterActividad([]); setFilterAntiguedad([]); setInactivity(EMPTY_INACTIVITY); setRowSelection({}); resetPage() }}>
            <X size={13} className="mr-1" /> Limpiar casino
          </Button>
        )}

        <label className="text-xs text-muted-foreground">Actividad reciente
          <select aria-label="Depósitos recientes" className="ml-2 h-8 rounded-md border bg-card px-2 text-sm" value={filterRecent} onChange={e=>{setFilterRecent(e.target.value);resetPage()}}>
            <option value="">Cualquier período</option><option value="30">Con depósitos en 30 días</option><option value="90">Con depósitos en 90 días</option>
          </select>
        </label>
        <span className="text-xs text-muted-foreground">Los períodos recientes corresponden al último cálculo. El nivel es global entre plataformas.</span>
        {/* ── Filtro plataforma ── */}
        <div className="flex max-w-full flex-wrap items-center gap-1 border rounded-lg p-0.5 bg-muted/40">
          {(['', 'zeus', 'bet30', 'ganamos', 'argenbet', 'otros'] as const).map(v => (
            <button
              key={v || 'all'}
              onClick={() => { setFilterPlataforma(v); resetPage() }}
              aria-pressed={filterPlataforma === v}
              className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors ${
                filterPlataforma === v
                  ? v === 'zeus'  ? 'bg-blue-600 text-white shadow-sm'
                  : v === 'bet30' ? 'bg-orange-500 text-white shadow-sm'
                  : v === 'ganamos' ? 'bg-green-600 text-white shadow-sm'
                  : v === 'argenbet' ? 'bg-purple-600 text-white shadow-sm'
                  : v === 'otros' ? 'bg-gray-600 text-white shadow-sm'
                  : 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {v === '' ? 'Todos' : v === 'zeus' ? 'Zeus' : v === 'bet30' ? 'Bet30' : v === 'ganamos' ? 'Ganamos' : v === 'argenbet' ? 'Argenbet' : 'Otros'}
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
          12 meses sin depósitos registrados
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

      </div>

      {/* Badge de lista activa */}
      {filterList && (() => {
        const active = lists.find(l => l.id === filterList)
        return active ? (
          <div className="flex items-center gap-2 text-xs text-primary bg-accent border border-primary/20 rounded-lg px-3 py-1.5">
            <Filter size={12} /> Mostrando lista: <span className="font-semibold">{active.name}</span>
            <span className="text-indigo-400">({active.contact_count.toLocaleString()} contactos)</span>
            <button onClick={() => { setFilterList(''); resetPage() }} className="ml-1 text-indigo-400 hover:text-primary">
              <X size={12} />
            </button>
          </div>
        ) : null
      })()}

      {/* ── DataTable ── */}
      <DataTable
        data={contacts}
        columns={[...columns.filter(c=>c.id==='name'),...columns.filter(c=>c.id!=='name')]}
        columnVisibility={contactColumns}
        onColumnVisibilityChange={setContactColumns}
        pinnedColumns={[{id:'select',width:48},{id:'name',width:230}]}
        onRowClick={openViewContact}
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
            message={loadError ? "No se pudieron cargar los contactos" : "Sin contactos"}
            description={loadError ? "Usá el botón de actualizar para volver a intentar." : "Ajustá los filtros o importá nuevos contactos."}
          />
        }
        bulkActions={(ids) => (
          <DataTableBulkActions
            selectedCount={ids.length}
            onClearSelection={() => setRowSelection({})}
          >
            <Button size="sm" variant="outline"
              onClick={() => { setListMode('selection'); setShowList(true) }}
              className="h-7 text-xs border-success/20 text-success hover:bg-success/10">
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
        if (!v) { setImportRows([]); setImportResult(null); setImporting(false); setImportError(null); setImportPanel(''); setImportPanel2(''); setImportLinea(''); setImportLineaSub(''); setImportCheck(null); setConflictMode('update') }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Upload size={16} /> Importar contactos</DialogTitle>
          </DialogHeader>
          {importResult ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="bg-success/10 rounded-lg p-4"><p className="text-2xl font-bold text-success">{importResult.inserted}</p><p className="text-xs text-muted-foreground">Creados</p></div>
                <div className="bg-blue-50 rounded-lg p-4"><p className="text-2xl font-bold text-blue-600">{importResult.updated}</p><p className="text-xs text-muted-foreground">Actualizados</p></div>
                <div className="bg-muted rounded-lg p-4"><p className="text-2xl font-bold text-muted-foreground">{importResult.skipped}</p><p className="text-xs text-muted-foreground">Omitidos</p></div>
              </div>
              <Button className="w-full" onClick={() => { setShowImport(false); setImportRows([]); setImportResult(null); setImportPanel(''); setImportPanel2(''); setImportLinea(''); setImportLineaSub('') }}>Cerrar</Button>
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
                <div className="border border-warning/20 bg-warning/10 rounded-lg p-3 space-y-2">
                  <p className="text-sm font-medium text-warning">
                    ⚠️ {importCheck.total.toLocaleString()} contactos ya existen en la base de datos
                  </p>
                  <div className="text-xs text-warning space-y-0.5">
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
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Variante (opcional)</label>
                  <Select value={importLineaSub || 'none'} onValueChange={v => setImportLineaSub(v === 'none' ? '' : (v ?? ''))} disabled={!importLinea}>
                    <SelectTrigger><SelectValue placeholder="Sin variante" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Sin variante</SelectItem>
                      {LINEA_SUB_OPTIONS.map(o => <SelectItem key={o.v} value={o.v}>{o.l}</SelectItem>)}
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
                <Button className="flex-1 bg-primary hover:bg-primary/90" onClick={confirmImport} disabled={importing}>
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
                Selección {selectedCount > 0 && `(${selectedCount})`}
              </button>
              <button onClick={() => setListMode('filters')}
                className={`flex-1 py-2 font-medium transition-colors border-l border-border ${listMode === 'filters' ? 'bg-violet-600 text-white' : 'bg-background text-muted-foreground hover:bg-muted'}`}>
                Filtros activos {hasActiveFilters && `(${total.toLocaleString()})`}
              </button>
              <button onClick={() => setListMode('criteria')}
                className={`flex-1 py-2 font-medium transition-colors border-l border-border ${listMode === 'criteria' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-muted'}`}>
                Por criterios
              </button>
            </div>
            {listMode === 'selection' && (
              <p className="text-sm text-muted-foreground">
                {selectedCount === 0 ? 'Seleccioná contactos en la tabla primero.' : `${selectedCount} contactos seleccionados.`}
              </p>
            )}
            {listMode === 'filters' && (
              <div className="space-y-2">
                {!hasActiveFilters ? (
                  <p className="text-sm text-muted-foreground bg-muted/50 rounded-lg px-3 py-3">
                    No hay filtros activos. Cerrá este modal, aplicá filtros en la tabla y volvé a abrir.
                  </p>
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Se incluirán los <span className="font-semibold">{total.toLocaleString()} contactos</span> que coinciden con los filtros actuales:
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {search && <span className="text-xs bg-muted text-foreground px-2 py-0.5 rounded-full">Búsqueda: &quot;{search}&quot;</span>}
                      {filterPanel && <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">Agente: {filterPanel}</span>}
                      {segments.length > 0 && <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">Nivel: {segments.join(', ')}</span>}
                      {(inactivity.min !== '' || inactivity.max !== '') && <span className="text-xs bg-success/15 text-success px-2 py-0.5 rounded-full">{inactivityLabel(inactivity)}</span>}
                      {filterActividad.length > 0 && <span className="text-xs bg-success/15 text-success px-2 py-0.5 rounded-full">Actividad: {filterActividad.join(', ')}</span>}
                      {filterAntiguedad.length > 0 && <span className="text-xs bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full">Antigüedad: {filterAntiguedad.join(', ')}</span>}
                      {filterPlataforma && <span className="text-xs bg-accent text-primary px-2 py-0.5 rounded-full">Plataforma: {filterPlataforma}</span>}
                      {filterGaming && <span className="text-xs bg-pink-100 text-pink-700 px-2 py-0.5 rounded-full">Juego: {filterGaming}</span>}
                      {filterLinea && <span className="text-xs bg-cyan-100 text-cyan-700 px-2 py-0.5 rounded-full">Línea: {filterLinea}</span>}
                      {filterLineaSub && <span className="text-xs bg-cyan-100 text-cyan-700 px-2 py-0.5 rounded-full">Variante: {filterLineaSub}</span>}
                      {filterSinMovimiento && <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full">12 meses sin depósitos registrados</span>}
                    </div>
                  </>
                )}
              </div>
            )}
            {listMode === 'filters' && <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
              <Checkbox checked={dynamicList} onCheckedChange={v=>setDynamicList(!!v)} />
              <span>Actualizar automáticamente con estos filtros<span className="block text-xs text-muted-foreground">Se evalúan antes de cada campaña y la audiencia queda fija al iniciarla. Quitá el filtro de lista para usar esta opción.</span></span>
            </label>}
            {listMode === 'criteria' && (
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
                className={`flex-1 ${listMode === 'criteria' ? 'bg-primary hover:bg-primary/90' : listMode === 'filters' ? 'bg-violet-600 hover:bg-violet-700' : 'bg-primary hover:bg-primary/90'}`}
                onClick={createList}
                disabled={
                  savingList || !newListName ||
                  (listMode === 'selection' && selectedCount === 0) ||
                  (listMode === 'criteria' && !criteriaPanel && !criteriaGaming && !criteriaSegment && !criteriaActividad && !criteriaAntiguedad) ||
                  (listMode === 'filters' && !hasActiveFilters)
                }>
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
              <label htmlFor="contact-phone" className="text-xs font-medium text-muted-foreground mb-1 block">Teléfono <span className="text-destructive">*</span></label>
              <Input id="contact-phone" type="tel" autoComplete="tel" aria-required="true" placeholder="Ej: 5492236123456" value={newPhone} onChange={e => setNewPhone(e.target.value)} />
            </div>
            <div>
              <label htmlFor="contact-name" className="text-xs font-medium text-muted-foreground mb-1 block">Nombre completo</label>
              <Input id="contact-name" autoComplete="name" placeholder="Ej: Juan Pérez" value={newName} onChange={e => setNewName(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: 'Panel', value: newPanel, set: setNewPanel, items: PANEL_OPTIONS.map(p => ({ v: p, l: p })), ph: 'Panel' },
                { label: 'Línea', value: newLinea, set: setNewLinea, items: Array.from({ length: 100 }, (_, i) => ({ v: String(i + 1), l: `Línea ${i + 1}` })), ph: 'Línea' },
                { label: 'Var.', value: newLineaSub, set: setNewLineaSub, items: LINEA_SUB_OPTIONS, ph: 'Var.' },
                { label: 'Juego', value: newGaming, set: setNewGaming, items: [{ v: 'slots', l: '🎰 Slots' }, { v: 'deportivas', l: '⚽ Deportivas' }, { v: 'ambas', l: '🎯 Ambas' }], ph: 'Juego' },
                { label: 'Nivel', value: newSegment, set: setNewSegment, items: [{ v: 'super_vip', l: 'Super Vip' }, { v: 'vip_alto', l: 'Vip Alto' }, { v: 'vip_medio', l: 'Vip Medio' }, { v: 'vip', l: 'Vip Bajo' }, { v: 'medio', l: 'Medio' }, { v: 'bajo', l: 'Bajo' }], ph: 'Nivel' },
              ].map(({ label, value, set, items, ph }) => (
                <div key={label}>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
                  <Select value={value} onValueChange={v => set(v ?? '')}>
                    <SelectTrigger aria-label={label} className="w-full"><SelectValue placeholder={ph} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">Sin {label.toLowerCase()}</SelectItem>
                      {items.map(i => <SelectItem key={i.v} value={i.v}>{i.l}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            {addError && <p role="alert" className="text-xs text-destructive">{addError}</p>}
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setShowAdd(false)}><X size={14} /> Cancelar</Button>
              <Button className="flex-1 bg-primary hover:bg-primary/90" onClick={addContact} disabled={addSaving}>
                {addSaving ? 'Guardando…' : 'Guardar contacto'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {/* ── Modal ver contacto ── */}
      <Dialog open={!!viewContact} onOpenChange={v => { if (!v) setViewContact(null) }}>
        <DialogContent className="crm-contact-drawer">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <button
                onClick={goPrevContact}
                disabled={viewContactIdx <= 0}
                className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Contacto anterior">
                <ChevronLeft size={16} />
              </button>
              <DialogTitle className="text-base flex-1 truncate">
                {viewContact ? `${viewContact.first_name || ''} ${viewContact.last_name || ''}`.trim() || viewContact.phone_number : ''}
              </DialogTitle>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {viewContactIdx + 1}/{contacts.length}
              </span>
              <button
                onClick={goNextContact}
                disabled={viewContactIdx >= contacts.length - 1}
                className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Siguiente contacto">
                <ChevronRight size={16} />
              </button>
            </div>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">Contacto {viewContactIdx+1} de {contacts.length} en esta página · tu selección se conserva</p>
          {viewContact && (
            <Tabs value={detailTab} onValueChange={setDetailTab} className="min-w-0">
              <TabsList className="w-full"><TabsTrigger value="resumen">Resumen</TabsTrigger><TabsTrigger value="actividad">Actividad</TabsTrigger>{(currentUser?.role==='admin'||currentUser?.sectors?.includes('conversations'))&&<TabsTrigger value="conversacion">Conversación</TabsTrigger>}</TabsList>
              <TabsContent value="resumen" className="space-y-4 pt-4">
              <p className="font-mono text-sm text-muted-foreground">{viewContact.phone_number}</p>
              <div className="flex flex-wrap gap-1.5">
                {viewContact.segment  && <span className={`text-xs px-2 py-0.5 rounded-full ${SEGMENT_STYLE[viewContact.segment] ?? 'bg-muted text-muted-foreground'}`}>{NIVEL_LABEL[viewContact.segment] ?? viewContact.segment}</span>}
                {viewContact.gaming   && <span className={`text-xs px-2 py-0.5 rounded-full ${GAMING_STYLE[viewContact.gaming] ?? 'bg-muted text-muted-foreground'}`}>{viewContact.gaming}</span>}
                {viewContact.actividad && <span className={`text-xs px-2 py-0.5 rounded-full ${ACTIVIDAD_STYLE[viewContact.actividad] ?? 'bg-muted text-muted-foreground'}`}>{viewContact.actividad}</span>}
                {viewContact.antiguedad && (
                  <span className={`relative group text-xs px-2 py-0.5 rounded-full cursor-help ${ANTIGUEDAD_STYLE[viewContact.antiguedad] ?? 'bg-muted text-muted-foreground'}`}>
                    {viewContact.antiguedad}
                    <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 rounded bg-gray-800 text-white text-[11px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-100 z-50">
                      {ANTIGUEDAD_DESC[viewContact.antiguedad]}
                    </span>
                  </span>
                )}
              </div>
              <SegmentationDetails profile={viewContact.segmentation_profile} quality={viewContact.data_quality} manual={viewContact.segment_is_manual} onAutomatic={async()=>{
                const res=await fetch(`/api/contacts/${viewContact.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({segment_mode:'automatic'})})
                if(!res.ok){const body=await res.json().catch(()=>({}));throw new Error(body.error||'No se pudo recuperar el nivel calculado')}
                load()
              }} />
              {/* Cuentas de casino por agente */}
              {(viewContact.casino_accounts?.length ?? 0) > 0 && (
                <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 space-y-1">
                  <p className="text-[10px] font-semibold text-blue-500 uppercase tracking-wide">Usuarios de casino</p>
                  {viewContact.casino_accounts!.map((acc, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground capitalize">{acc.panel}</span>
                      <span className="text-xs font-mono font-medium text-foreground">{acc.username}</span>
                    </div>
                  ))}
                </div>
              )}
              {/* Tags del contacto */}
              {(viewContact.custom_tags?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-1">
                  {viewContact.custom_tags!.map(t => (
                    <span key={t} className="text-xs bg-accent border border-input text-foreground hover:bg-muted px-2 py-0.5 rounded-full">{t}</span>
                  ))}
                </div>
              )}

              </TabsContent>
              <TabsContent value="actividad" className="space-y-4 pt-4"><h3 className="text-sm font-semibold">Historial por plataforma</h3>              {casinoStatsError && <p role="alert" className="text-sm text-destructive">{casinoStatsError}</p>}
              {!casinoStats && !casinoStatsError && <p className="text-sm text-muted-foreground">Cargando historial…</p>}
              {casinoStats?.platforms.length === 0 && <p className="text-sm text-muted-foreground">Sin historial vinculado. No permite determinar la actividad.</p>}
              {casinoStats?.platforms.map(stats => (
                <div key={stats.platform ?? 'unknown'} className="rounded-lg border border-border bg-background p-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{stats.platform ?? 'Historial sin plataforma'}</p>
                    <span className="text-xs text-muted-foreground">{stats.mes_referencia ?? 'Histórico total'}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div><p className="text-xl font-bold">${stats.monto_cargas_mes.toLocaleString('es-AR')}</p>
                      <p className="text-xs text-muted-foreground">{stats.fuente === 'historico' ? 'Cargas total' : 'Cargas del mes'}</p></div>
                    <div><p className="text-xl font-bold">${stats.monto_retiros_mes.toLocaleString('es-AR')}</p>
                      <p className="text-xs text-muted-foreground">{stats.fuente === 'historico' ? 'Retiros total' : 'Retiros del mes'}</p></div>
                    <div><p className="text-sm font-semibold">{stats.last_deposit_at
                      ? new Date(stats.last_deposit_at.length === 10 ? `${stats.last_deposit_at}T12:00:00` : stats.last_deposit_at).toLocaleDateString('es-AR') : '—'}</p>
                      <p className="text-xs text-muted-foreground">Última carga</p></div>
                  </div>
                </div>
              ))}
</TabsContent>
              <TabsContent value="conversacion" className="pt-4">{(currentUser?.role==='admin'||currentUser?.sectors?.includes('conversations'))&&<ContactMessages phone={viewContact.phone_number}/>}</TabsContent>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="flex-1" onClick={() => openEdit(viewContact)}>
                  <Pencil size={13} className="mr-1.5" /> Editar
                </Button>
                <Button variant="outline" size="sm" className="flex-1" onClick={() => openTags(viewContact)}>
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
            </Tabs>
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
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: 'Panel',  value: editPanel,   set: setEditPanel,   items: PANEL_OPTIONS.map(p => ({ v: p, l: p })),                                                                                          ph: 'Panel'  },
                { label: 'Línea',  value: editLinea,   set: setEditLinea,   items: Array.from({ length: 100 }, (_, i) => ({ v: String(i + 1), l: `Línea ${i + 1}` })),                                               ph: 'Línea'  },
                { label: 'Var.',   value: editLineaSub, set: setEditLineaSub, items: LINEA_SUB_OPTIONS,                                                                                                             ph: 'Var.'   },
                { label: 'Juego',  value: editGaming,  set: setEditGaming,  items: [{ v: 'slots', l: '🎰 Slots' }, { v: 'deportivas', l: '⚽ Deportivas' }, { v: 'ambas', l: '🎯 Ambas' }],                         ph: 'Juego'  },
                { label: 'Nivel',  value: editSegment, set: setEditSegment, items: [{ v: 'super_vip', l: 'Super Vip' }, { v: 'vip_alto', l: 'Vip Alto' }, { v: 'vip_medio', l: 'Vip Medio' }, { v: 'vip', l: 'Vip Bajo' }, { v: 'medio', l: 'Medio' }, { v: 'bajo', l: 'Bajo' }], ph: 'Nivel' },
              ].map(({ label, value, set, items, ph }) => (
                <div key={label}>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
                  <Select value={value} onValueChange={v => set(v ?? '')}>
                    <SelectTrigger aria-label={label} className="w-full"><SelectValue placeholder={ph} /></SelectTrigger>
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
              <div className="rounded-lg border border-border bg-background p-3 space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Historial del jugador</p>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div>
                    <p className="text-lg font-bold text-foreground">{editContact.total_deposits ?? 0}</p>
                    <p className="text-[10px] text-muted-foreground">Cargas (mes)</p>
                  </div>
                  <div>
                    <p className="text-lg font-bold text-foreground">{editContact.total_withdrawals ?? 0}</p>
                    <p className="text-[10px] text-muted-foreground">Retiros (mes)</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-foreground">
                      {editContact.last_deposit_at
                        ? new Date(editContact.last_deposit_at).toLocaleDateString('es-AR')
                        : '—'}
                    </p>
                    <p className="text-[10px] text-muted-foreground">Última carga</p>
                  </div>
                </div>
                {editContact.total_deposits === 1 && editContact.last_deposit_at &&
                  (Date.now() - new Date(editContact.last_deposit_at).getTime()) > 10 * 24 * 60 * 60 * 1000 && (
                  <p className="text-[10px] text-warning bg-warning/10 border border-warning/20 rounded px-2 py-1 text-center">
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
                <span key={t} className="inline-flex items-center gap-1 text-xs bg-accent border border-input text-foreground hover:bg-muted px-2 py-0.5 rounded-full">
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
              <Scissors size={16} className="text-primary" />
              Dividir lista
            </DialogTitle>
          </DialogHeader>

          {splitResult ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Las listas fueron creadas correctamente:</p>
              <div className="space-y-2">
                {splitResult.map((l, i) => (
                  <div key={l.id} className="flex items-center gap-2 bg-accent rounded-lg px-3 py-2">
                    <span className="text-xs font-semibold text-primary w-5">{i + 1}.</span>
                    <span className="text-sm font-medium text-indigo-900 flex-1 truncate">{l.name}</span>
                    <span className="text-xs text-indigo-500 shrink-0">{l.total.toLocaleString()} contactos</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">La lista original no fue modificada.</p>
              <div className="flex justify-end">
                <Button size="sm" onClick={() => { setSplitSource(null); setSplitResult(null) }}>Listo</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <p className="text-sm text-muted-foreground mb-1">
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
                          ? 'border-primary bg-accent text-primary'
                          : 'border-border text-muted-foreground hover:border-indigo-300'
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
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Nombres de las partes</p>
                {splitNames.map((name, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-5 text-right">{i + 1}.</span>
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

              <p className="text-xs text-muted-foreground">
                Los contactos se distribuyen aleatoriamente. La lista original no se modifica.
              </p>

              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => setSplitSource(null)}>Cancelar</Button>
                <Button
                  size="sm"
                  onClick={doSplit}
                  disabled={splittingList || splitNames.some(n => !n.trim())}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  {splittingList ? 'Dividiendo…' : `Crear ${splitParts} listas`}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {/* ── Modal confirmación bulk (delete / blacklist) ── */}
      <Dialog open={!!confirmBulk} onOpenChange={v => { if (!v && !confirmExecuting) setConfirmBulk(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {confirmBulk?.action === 'delete'
                ? <><Trash2 size={16} className="text-destructive" /> Eliminar contactos</>
                : <><Ban size={16} className="text-orange-600" /> Agregar a blacklist</>}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Vas a{' '}
              <span className="font-semibold text-foreground">
                {confirmBulk?.action === 'delete' ? 'eliminar' : 'agregar a la blacklist'}
              </span>{' '}
              <span className="font-semibold text-foreground">
                {confirmBulk?.count.toLocaleString()} contactos
              </span>{' '}
              {confirmBulk?.mode === 'filters' ? 'que coinciden con los filtros actuales' : 'seleccionados'}.
            </p>
            {confirmBulk?.mode === 'filters' && (
              <div className="flex flex-wrap gap-1.5 p-2 bg-muted/50 rounded-lg">
                {filterPanel && <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">Agente: {filterPanel}</span>}
                {segments.length > 0 && <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">Nivel: {segments.join(', ')}</span>}
                {(inactivity.min !== '' || inactivity.max !== '') && <span className="text-xs bg-success/15 text-success px-2 py-0.5 rounded-full">{inactivityLabel(inactivity)}</span>}
                      {filterActividad.length > 0 && <span className="text-xs bg-success/15 text-success px-2 py-0.5 rounded-full">Actividad: {filterActividad.join(', ')}</span>}
                {filterAntiguedad.length > 0 && <span className="text-xs bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full">Antigüedad: {filterAntiguedad.join(', ')}</span>}
                {filterPlataforma && <span className="text-xs bg-accent text-primary px-2 py-0.5 rounded-full">Plataforma: {filterPlataforma}</span>}
                {filterLinea && <span className="text-xs bg-cyan-100 text-cyan-700 px-2 py-0.5 rounded-full">Línea: {filterLinea}</span>}
                {filterLineaSub && <span className="text-xs bg-cyan-100 text-cyan-700 px-2 py-0.5 rounded-full">Variante: {filterLineaSub}</span>}
                {filterGaming && <span className="text-xs bg-pink-100 text-pink-700 px-2 py-0.5 rounded-full">Juego: {filterGaming}</span>}
                {filterSinMovimiento && <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full">12 meses sin depósitos registrados</span>}
              </div>
            )}
            {confirmBulk?.action === 'delete' && (
              <p className="text-xs text-destructive font-medium">Esta acción no se puede deshacer.</p>
            )}
            {confirmError && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{confirmError}</p>}
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setConfirmBulk(null)} disabled={confirmExecuting}>
                <X size={14} className="mr-1" /> Cancelar
              </Button>
              <Button
                className={`flex-1 text-white ${confirmBulk?.action === 'delete' ? 'bg-destructive hover:bg-destructive/90' : 'bg-orange-600 hover:bg-orange-700'}`}
                onClick={executeConfirm}
                disabled={confirmExecuting}>
                {confirmExecuting ? 'Procesando…' : 'Confirmar'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      </> /* fin activeTab === 'contacts' */}
    </div>
  )
}
