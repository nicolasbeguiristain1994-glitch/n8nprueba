'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import * as XLSX from 'xlsx'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Upload, RefreshCw, Trash2, Search, Send, History, AlertTriangle,
  CheckCircle, XCircle, ChevronLeft, ChevronRight, Eye, UserPlus,
  CheckSquare, List, ChevronDown, X, Filter, Users, Download,
  Tag, Ban,
} from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { fetchJson } from '@/lib/fetchJson'
import type { Prospect, ProspectImportBatch, ProspectImportResult, ProspectStage } from '@/lib/prospects'
import { PROSPECT_STAGE_LABELS } from '@/lib/prospects'
import { DownloadContactsModal } from '@/components/contacts/DownloadContactsModal'

// ── Tipos locales ─────────────────────────────────────────────────────────────

interface Campaign {
  id:     string
  name:   string
  status: string
}

interface ParsedRow {
  phone:      string
  first_name: string | null
  last_name:  string | null
  email:      string | null
  raw:        string   // línea original para debug
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizePhone(raw: string): string {
  const cleaned = raw.trim().replace(/[\s\-().]/g, '')
  if (!cleaned.startsWith('+')) return `+${cleaned}`
  return cleaned
}

function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') { inQuotes = !inQuotes; continue }
    if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue }
    current += ch
  }
  result.push(current.trim())
  return result
}

function detectColumns(headers: string[]): { phone: number; firstName: number; lastName: number; email: number } {
  const h = headers.map(s => s.toLowerCase().replace(/[^a-z0-9]/g, ''))
  const find = (...keys: string[]) => h.findIndex(col => keys.some(k => col.includes(k)))
  return {
    phone:     find('phone', 'whatsapp', 'wpp', 'telefono', 'tel', 'celular', 'numero', 'nro', 'number', 'movil', 'mobile', 'contacto', 'cel'),
    firstName: find('firstname', 'nombre', 'name', 'first', 'usuario', 'user', 'cliente', 'jugador'),
    lastName:  find('lastname', 'apellido', 'last'),
    email:     find('email', 'correo', 'mail'),
  }
}

// Detecta cuál columna de la primera fila parece un número de teléfono
function detectPhoneColumnByContent(rows: string[][]): number {
  const phoneRe = /^\+?[\d\s\-().]{7,}$/
  if (!rows.length) return 0
  const sample = rows.slice(0, Math.min(5, rows.length))
  const colCount = Math.max(...sample.map(r => r.length))
  for (let col = 0; col < colCount; col++) {
    const matches = sample.filter(r => phoneRe.test((r[col] ?? '').trim())).length
    if (matches >= Math.ceil(sample.length * 0.6)) return col
  }
  return 0
}

// ── Stage badge ───────────────────────────────────────────────────────────────

const STAGE_CLASSES: Record<ProspectStage, string> = {
  nuevo:      'bg-gray-100 text-gray-600 border-gray-200',
  contactado: 'bg-blue-100 text-blue-700 border-blue-200',
  interesado: 'bg-amber-100 text-amber-700 border-amber-200',
  descartado: 'bg-red-100 text-red-600 border-red-200',
}

function StageBadge({ stage }: { stage: ProspectStage | undefined }) {
  const s = stage ?? 'nuevo'
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STAGE_CLASSES[s]}`}>
      {PROSPECT_STAGE_LABELS[s]}
    </span>
  )
}

// ── Componente principal ──────────────────────────────────────────────────────

export function ProspectsTab() {
  // ── Datos
  const [prospects, setProspects]   = useState<Prospect[]>([])
  const [total, setTotal]           = useState(0)
  const [loading, setLoading]       = useState(false)
  const [batches, setBatches]       = useState<ProspectImportBatch[]>([])
  const [campaigns, setCampaigns]   = useState<Campaign[]>([])

  // ── Filtros / paginación
  const [search, setSearch]         = useState('')
  const [filterBatch, setFilterBatch] = useState('')
  const [filterStatus, setFilterStatus] = useState('')   // '' = todos
  const [filterStage, setFilterStage]   = useState('')   // '' = todas las etapas
  const [filterTag, setFilterTag]       = useState('')   // '' = todas las etiquetas
  const [page, setPage]             = useState(1)
  const limit = 50

  // ── Selección
  const [selected, setSelected]     = useState<Set<string>>(new Set())
  const [selectAllMode, setSelectAllMode] = useState(false)  // selecciona todos los de la búsqueda (no solo la página)

  // ── Listas de difusión (filtro)
  const [prospectLists, setProspectLists] = useState<{id: string; name: string; member_count: number}[]>([])
  const [filterList, setFilterList]       = useState('')
  const [showListsMenu, setShowListsMenu] = useState(false)
  const listsMenuRef = useRef<HTMLDivElement>(null)

  // ── Modal importación
  const [importOpen, setImportOpen]       = useState(false)
  const [parsedRows, setParsedRows]       = useState<ParsedRow[]>([])
  const [importFilename, setImportFilename] = useState('')
  const [importing, setImporting]         = useState(false)
  const [importProgress, setImportProgress] = useState(0)   // 0-100
  const [importResult, setImportResult]   = useState<ProspectImportResult | null>(null)
  const [autoPrefix, setAutoPrefix]       = useState('')    // p.ej. '+549' para Argentina
  const [autoNumber, setAutoNumber]       = useState(false) // numerar contactos con nombre repetido
  const [repeatName, setRepeatName]       = useState<string | null>(null) // nombre que se repite, si aplica
  const [mostlyNoNames, setMostlyNoNames] = useState(false) // mayoría sin nombre → ofrecer prefijo manual
  const [manualPrefix, setManualPrefix]   = useState('')    // prefijo ingresado por el usuario (ej: "Trebol")
  const fileRef = useRef<HTMLInputElement>(null)

  // ── Modal agregar a campaña
  const [addCampaignOpen, setAddCampaignOpen]   = useState(false)
  const [selectedCampaign, setSelectedCampaign] = useState('')
  const [addingToCampaign, setAddingToCampaign] = useState(false)
  const [addResult, setAddResult]               = useState<{ added: number; already: number } | null>(null)

  // ── Modal crear lista de difusión
  const [createListOpen, setCreateListOpen]       = useState(false)
  const [createListName, setCreateListName]       = useState('')
  const [creatingList, setCreatingList]           = useState(false)
  const [createListError, setCreateListError]     = useState<string | null>(null)
  const [createListResult, setCreateListResult]   = useState<{ id: string; member_count: number } | null>(null)

  // ── Modal historial de batches
  const [batchHistoryOpen, setBatchHistoryOpen] = useState(false)
  const [deletingBatchId, setDeletingBatchId]   = useState<string | null>(null)

  // ── Corrección de prefijo en batch existente
  const [fixingPrefix, setFixingPrefix] = useState(false)

  // ── Modal descarga
  const [showDownloadModal, setShowDownloadModal] = useState(false)

  // ── Tags de prospecto
  const [tagsInput, setTagsInput]   = useState('')
  const [tagsSaving, setTagsSaving] = useState(false)

  // ── Blacklist
  const [blacklistSaving, setBlacklistSaving] = useState(false)

  // ── Dropdown custom de batches
  const [showBatchMenu, setShowBatchMenu] = useState(false)
  const batchMenuRef = useRef<HTMLDivElement>(null)

  // ── Diálogo de confirmación estilizado
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string
    message: string
    confirmLabel?: string
    variant?: 'danger' | 'warning'
    onConfirm: () => void
  } | null>(null)
  const showConfirm = (opts: NonNullable<typeof confirmDialog>) => setConfirmDialog(opts)

  // ── Diálogo de información / resultado (sin cancelar, solo cerrar)
  const [infoDialog, setInfoDialog] = useState<{
    title: string
    message: string
    variant?: 'success' | 'error' | 'info'
  } | null>(null)
  const showInfo = (opts: NonNullable<typeof infoDialog>) => setInfoDialog(opts)

  // ── Modal detalle + conversión
  const [detailProspect, setDetailProspect]   = useState<Prospect | null>(null)
  const [convertStep, setConvertStep]         = useState<'idle' | 'confirm' | 'done'>('idle')
  const [convertNotes, setConvertNotes]       = useState('')
  const [converting, setConverting]           = useState(false)
  const [convertResult, setConvertResult]     = useState<{ contact_id: string; warning?: string } | null>(null)
  const [updatingStage, setUpdatingStage]     = useState(false)

  // ── Carga ─────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const q = new URLSearchParams({
        q:        search,
        page:     String(page),
        limit:    String(limit),
        batch_id: filterBatch,
        status:   filterStatus,
        stage:    filterStage,
        list_id:  filterList,
        tag:      filterTag,
      })
      const data = await fetchJson<{ prospects: Prospect[]; total: number }>(`/api/prospects?${q}`)
      setProspects(data.prospects ?? [])
      setTotal(data.total ?? 0)
    } finally {
      setLoading(false)
    }
  }, [search, page, filterBatch, filterStatus, filterStage, filterList, filterTag])

  // Limpiar selección cuando cambian los filtros (pero NO al cambiar de página)
  useEffect(() => {
    setSelected(new Set())
    setSelectAllMode(false)
  }, [search, filterBatch, filterStatus, filterStage, filterList, filterTag])

  useEffect(() => { load() }, [load])

  const loadBatches = useCallback(() => {
    fetchJson<{ batches: ProspectImportBatch[] }>('/api/prospects/batches')
      .then(d => setBatches(d.batches ?? []))
      .catch(() => {})
  }, [])

  useEffect(() => { loadBatches() }, [loadBatches])

  const deleteBatch = async (batchId: string) => {
    setDeletingBatchId(batchId)
    try {
      await fetchJson(`/api/prospects/batches/${batchId}`, { method: 'DELETE' })
      setBatches(prev => prev.filter(b => b.id !== batchId))
      if (filterBatch === batchId) { setFilterBatch(''); setPage(1) }
    } catch {
      showInfo({ title: 'Error', message: 'No se pudo eliminar el batch. Intentá de nuevo.', variant: 'error' })
    } finally {
      setDeletingBatchId(null)
    }
  }

  useEffect(() => {
    fetchJson<{ lists: {id: string; name: string; member_count: number}[] }>('/api/prospect-lists?limit=100')
      .then(d => setProspectLists(d.lists ?? []))
      .catch(() => {})
  }, [])

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

  useEffect(() => {
    if (!showBatchMenu) return
    const handler = (e: MouseEvent) => {
      if (batchMenuRef.current && !batchMenuRef.current.contains(e.target as Node)) {
        setShowBatchMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showBatchMenu])

  // ── Selección ─────────────────────────────────────────────────────────────

  const toggleSelect = (id: string) =>
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const toggleAll = () => {
    setSelectAllMode(false)
    const allCurrentSelected = prospects.length > 0 && prospects.every(p => selected.has(p.id))
    setSelected(prev => {
      const next = new Set(prev)
      if (allCurrentSelected) {
        prospects.forEach(p => next.delete(p.id))
      } else {
        prospects.forEach(p => next.add(p.id))
      }
      return next
    })
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  const deleteSelected = () => {
    if (!selected.size && !selectAllMode) return

    if (selectAllMode) {
      showConfirm({
        title: 'Eliminar todos los prospectos',
        message: `Se eliminarán los ${total.toLocaleString()} prospectos de esta búsqueda. Los convertidos serán ignorados. Esta acción no se puede deshacer.`,
        confirmLabel: `Eliminar ${total.toLocaleString()}`,
        variant: 'danger',
        onConfirm: async () => {
          await fetchJson('/api/prospects', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filters: { q: search, status: filterStatus, stage: filterStage, batch_id: filterBatch, list_id: filterList } }),
          }).catch(() => {})
          setSelectAllMode(false)
          load()
        },
      })
      return
    }

    const toDelete = [...selected]
    showConfirm({
      title: 'Eliminar prospectos seleccionados',
      message: `Se eliminarán ${toDelete.length} prospecto(s). Los convertidos serán ignorados. Esta acción no se puede deshacer.`,
      confirmLabel: `Eliminar ${toDelete.length}`,
      variant: 'danger',
      onConfirm: async () => {
        await fetchJson('/api/prospects', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: toDelete }),
        }).catch(() => {})
        setSelected(new Set())
        load()
      },
    })
  }

  // ── Parse archivo ─────────────────────────────────────────────────────────

  const handleFile = async (file: File) => {
    setImportFilename(file.name)
    setImportResult(null)
    setParsedRows([])
    setAutoPrefix('')

    const ext = file.name.split('.').pop()?.toLowerCase()
    let rows: ParsedRow[] = []

    if (ext === 'csv' || ext === 'txt') {
      const text = await file.text()
      const lines = text.split(/\r?\n/).filter(l => l.trim())
      if (!lines.length) return

      const headers = parseCSVLine(lines[0])
      const cols    = detectColumns(headers)

      if (cols.phone === -1) {
        // Detectar por contenido usando todas las líneas
        const allParsed = lines.map(l => parseCSVLine(l))
        const phoneCol  = detectPhoneColumnByContent(allParsed.slice(0, 6))
        const nameCol   = phoneCol === 0 ? 1 : 0
        const phoneRe   = /^\+?[\d\s\-().]{7,}$/
        const firstIsHeader = !phoneRe.test((allParsed[0][phoneCol] ?? '').trim())
        const dataRows  = firstIsHeader ? allParsed.slice(1) : allParsed
        rows = dataRows.map(parts => ({
          phone:      normalizePhone(parts[phoneCol] || ''),
          first_name: parts[nameCol]?.trim() || null,
          last_name:  null,
          email:      null,
          raw:        parts.join(','),
        }))
      } else {
        rows = lines.slice(1).map(line => {
          const parts = parseCSVLine(line)
          return {
            phone:      normalizePhone(parts[cols.phone] || ''),
            first_name: cols.firstName >= 0 ? parts[cols.firstName]?.trim() || null : null,
            last_name:  cols.lastName  >= 0 ? parts[cols.lastName ]?.trim() || null : null,
            email:      cols.email     >= 0 ? parts[cols.email    ]?.trim() || null : null,
            raw:        line,
          }
        })
      }
    } else if (ext === 'xlsx' || ext === 'xls') {
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const allData: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
      if (!allData.length) return

      const allRows = allData.map(r => (r as unknown[]).map(String))
      const headers = allRows[0]
      const cols    = detectColumns(headers)

      if (cols.phone !== -1) {
        // Headers reconocidos — primera fila es header
        rows = allRows.slice(1).map(r => ({
          phone:      normalizePhone(r[cols.phone] || ''),
          first_name: cols.firstName >= 0 ? r[cols.firstName]?.trim() || null : null,
          last_name:  cols.lastName  >= 0 ? r[cols.lastName ]?.trim() || null : null,
          email:      cols.email     >= 0 ? r[cols.email    ]?.trim() || null : null,
          raw:        r.join(','),
        }))
      } else {
        // Detectar columna de teléfono por contenido usando todas las filas
        const phoneCol = detectPhoneColumnByContent(allRows.slice(0, 6))
        const nameCol  = phoneCol === 0 ? 1 : 0
        // Determinar si la primera fila es header (valor en phoneCol no es teléfono)
        const phoneRe  = /^\+?[\d\s\-().]{7,}$/
        const firstIsHeader = !phoneRe.test((allRows[0][phoneCol] ?? '').trim())
        const dataRows = firstIsHeader ? allRows.slice(1) : allRows
        rows = dataRows.map(r => ({
          phone:      normalizePhone(r[phoneCol] || ''),
          first_name: r[nameCol]?.trim() || null,
          last_name:  null,
          email:      null,
          raw:        r.join(','),
        }))
      }
    } else if (ext === 'vcf') {
      const text = await file.text()
      const blocks = text.split(/BEGIN:VCARD/i).slice(1)
      for (const block of blocks) {
        // Manejo de line folding (líneas que empiezan con espacio son continuaciones)
        const lines = block.split(/\r?\n/).reduce<string[]>((acc, line) => {
          if (/^[ \t]/.test(line) && acc.length) { acc[acc.length - 1] += line.slice(1) }
          else { acc.push(line) }
          return acc
        }, [])

        let phone: string | null = null
        let firstName: string | null = null
        let lastName: string | null = null
        let email: string | null = null

        for (const line of lines) {
          const upper = line.toUpperCase()
          if (upper.startsWith('TEL') && phone === null) {
            const val = line.slice(line.lastIndexOf(':') + 1).trim()
            if (val) phone = val
          } else if (upper.startsWith('FN:')) {
            const val = line.slice(3).trim()
            if (val) firstName = val
          } else if (upper.startsWith('N:') && !firstName) {
            const parts = line.slice(2).split(';')
            lastName  = parts[0]?.trim() || null
            firstName = parts[1]?.trim() || null
          } else if (upper.startsWith('EMAIL') && email === null) {
            const val = line.slice(line.lastIndexOf(':') + 1).trim()
            if (val) email = val
          }
        }

        if (phone) {
          rows.push({
            phone:      normalizePhone(phone),
            first_name: firstName,
            last_name:  lastName,
            email:      email,
            raw:        `vcf:${phone}`,
          })
        }
      }
    }

    const validRows = rows.filter(r => r.phone.length > 2)
    setParsedRows(validRows)
    // Auto-activar prefijo si la mayoría de números no tiene código de Argentina
    const withoutPrefix = validRows.filter(r => !r.phone.startsWith('+54')).length
    setAutoPrefix(withoutPrefix > validRows.length / 2 ? '+549' : '')
    // Detectar si todos los contactos tienen el mismo nombre (ej. "WONBET")
    const names = validRows.map(r => (r.first_name ?? '').trim()).filter(Boolean)
    const uniqueNames = new Set(names)
    const detected = names.length >= 2 && uniqueNames.size === 1 ? names[0] : null
    setRepeatName(detected)
    setAutoNumber(detected !== null)
    // Detectar si la mayoría no tiene nombre → ofrecer prefijo manual
    const noNameCount = validRows.filter(r => !(r.first_name ?? '').trim()).length
    setMostlyNoNames(validRows.length > 0 && noNameCount > validRows.length * 0.8)
    setManualPrefix('')
    setImportOpen(true)
  }

  // ── Confirmar importación (chunked para archivos grandes) ────────────────────

  const CHUNK_SIZE = 5_000

  const confirmImport = async () => {
    if (!parsedRows.length) return
    setImporting(true)
    setImportProgress(0)

    const allRows = parsedRows.map((r, i) => {
      const phone = autoPrefix && !r.phone.startsWith('+54')
        ? autoPrefix + r.phone.slice(1)
        : r.phone
      let first_name = r.first_name
      if (autoNumber && repeatName && r.first_name?.trim() === repeatName) {
        first_name = `${repeatName} ${i + 1}`
      } else if (manualPrefix.trim() && !(r.first_name ?? '').trim()) {
        first_name = `${manualPrefix.trim()} ${i + 1}`
      }
      return { phone, first_name, last_name: r.last_name, email: r.email }
    })
    const chunks: typeof allRows[] = []
    for (let i = 0; i < allRows.length; i += CHUNK_SIZE) chunks.push(allRows.slice(i, i + CHUNK_SIZE))

    let batchId: string | null = null
    let totalImported = 0, totalDuplicates = 0, totalInvalid = 0

    try {
      for (let i = 0; i < chunks.length; i++) {
        const isFirst = i === 0
        const body: Record<string, unknown> = isFirst
          ? { rows: chunks[i], filename: importFilename, total_rows: allRows.length }
          : { rows: chunks[i], batch_id: batchId }

        const result = await fetchJson<ProspectImportResult>('/api/prospects/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })

        if (isFirst) batchId = result.batch_id
        totalImported   += result.imported
        totalDuplicates += result.skipped_duplicates
        totalInvalid    += result.skipped_invalid
        setImportProgress(Math.round(((i + 1) / chunks.length) * 100))
      }

      const finalResult: ProspectImportResult = {
        batch_id: batchId,
        imported: totalImported,
        skipped_duplicates: totalDuplicates,
        skipped_invalid: totalInvalid,
        warned_existing_contacts: 0,
        total_rows: allRows.length,
        warnings: [],
      }
      setImportResult(finalResult)
      setBatches(prev => batchId
        ? [{ id: batchId!, filename: importFilename, total_rows: allRows.length,
             imported: totalImported, skipped_duplicates: totalDuplicates,
             skipped_invalid: totalInvalid, warned_existing_contacts: 0,
             notes: null, created_at: new Date().toISOString() }, ...prev]
        : prev
      )
      load()
    } finally {
      setImporting(false)
    }
  }

  // ── Agregar a campaña ─────────────────────────────────────────────────────

  const openAddToCampaign = async () => {
    setAddResult(null)
    setSelectedCampaign('')
    if (!campaigns.length) {
      const data = await fetchJson<{ campaigns: Campaign[] }>('/api/campaigns?status=draft,paused,ready&limit=100').catch(() => ({ campaigns: [] }))
      setCampaigns((data.campaigns ?? []).filter(c => !['sent', 'cancelled'].includes(c.status)))
    }
    setAddCampaignOpen(true)
  }

  const confirmAddToCampaign = async () => {
    if (!selectedCampaign) return
    setAddingToCampaign(true)
    try {
      const ids = [...selected]
      const result = await fetchJson<{ added: number; already_in_campaign: number }>(
        `/api/campaigns/${selectedCampaign}/add-prospects`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prospect_ids: ids }),
        }
      )
      setAddResult({ added: result.added, already: result.already_in_campaign })
    } finally {
      setAddingToCampaign(false)
    }
  }

  // ── Crear lista de difusión desde selección ──────────────────────────────────

  const createListFromProspects = async () => {
    if (!createListName.trim()) { setCreateListError('El nombre es requerido'); return }
    setCreatingList(true); setCreateListError(null)
    try {
      const res = await fetch('/api/prospect-lists/from-selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:         createListName.trim(),
          prospect_ids: Array.from(selected),
        }),
      })
      const d = await res.json()
      if (!res.ok) { setCreateListError(d.error || 'Error al crear la lista'); return }
      setCreateListResult(d)
    } catch { setCreateListError('Error de red') }
    finally { setCreatingList(false) }
  }

  // ── Tags de prospecto ─────────────────────────────────────────────────────

  const addProspectTag = () => {
    if (!detailProspect) return
    const t = tagsInput.trim().toLowerCase().replace(/[^a-z0-9_\- ]/g, '')
    if (!t || (detailProspect.tags ?? []).includes(t)) { setTagsInput(''); return }
    const newTags = [...(detailProspect.tags ?? []), t]
    setDetailProspect(p => p ? { ...p, tags: newTags } : p)
    setTagsInput('')
  }

  const removeProspectTag = (tag: string) => {
    if (!detailProspect) return
    const newTags = (detailProspect.tags ?? []).filter(t => t !== tag)
    setDetailProspect(p => p ? { ...p, tags: newTags } : p)
  }

  const saveProspectTags = async () => {
    if (!detailProspect) return
    setTagsSaving(true)
    // Si hay texto en el input, lo agregamos antes de guardar
    const pending = tagsInput.trim().toLowerCase().replace(/[^a-z0-9_\- ]/g, '')
    const currentTags = detailProspect.tags ?? []
    const finalTags = pending && !currentTags.includes(pending)
      ? [...currentTags, pending]
      : currentTags
    if (pending) {
      setDetailProspect(p => p ? { ...p, tags: finalTags } : p)
      setTagsInput('')
    }
    try {
      await fetchJson(`/api/prospects/${detailProspect.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: finalTags }),
      })
      setProspects(prev => prev.map(p => p.id === detailProspect.id ? { ...p, tags: finalTags } : p))
      showInfo({ title: 'Etiquetas guardadas', message: `${finalTags.length} etiqueta(s) guardada(s).`, variant: 'success' })
    } catch {
      showInfo({ title: 'Error', message: 'No se pudieron guardar las etiquetas.', variant: 'error' })
    } finally {
      setTagsSaving(false)
    }
  }

  // ── Blacklist ─────────────────────────────────────────────────────────────

  const sendToBlacklist = async (phones: string[], onDone?: () => void) => {
    setBlacklistSaving(true)
    try {
      const res = await fetch('/api/blacklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phones }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        showInfo({ title: 'Error', message: data.error || 'Error al agregar a blacklist.', variant: 'error' })
        return
      }
      onDone?.()
    } catch {
      showInfo({ title: 'Error', message: 'Error de conexión.', variant: 'error' })
    } finally {
      setBlacklistSaving(false)
    }
  }

  const blacklistProspect = (p: Prospect) => {
    showConfirm({
      title: 'Agregar a blacklist',
      message: `¿Agregar ${[p.first_name, p.last_name].filter(Boolean).join(' ') || p.phone_number} a la blacklist? No recibirá más mensajes.`,
      confirmLabel: 'Agregar a blacklist',
      variant: 'warning',
      onConfirm: () => sendToBlacklist([p.phone_number], () => {
        closeDetail()
        showInfo({ title: 'Blacklist', message: 'Prospecto agregado a la blacklist.', variant: 'success' })
      }),
    })
  }

  const blacklistSelected = () => {
    const count = selectAllMode ? total : selected.size
    showConfirm({
      title: 'Agregar a blacklist',
      message: `¿Agregar ${count.toLocaleString()} prospecto(s) a la blacklist? No recibirán más mensajes.`,
      confirmLabel: `Agregar ${count.toLocaleString()} a blacklist`,
      variant: 'warning',
      onConfirm: async () => {
        if (selectAllMode) {
          // Fetch all phones from current filter
          const q = new URLSearchParams({ q: search, status: filterStatus, stage: filterStage, batch_id: filterBatch, list_id: filterList, download: 'true' })
          try {
            const data = await fetchJson<{ contacts: Prospect[] }>(`/api/prospects?${q}`)
            const phones = (data.contacts ?? []).map((p: Prospect) => p.phone_number)
            await sendToBlacklist(phones, () => {
              setSelectAllMode(false)
              showInfo({ title: 'Blacklist', message: `${phones.length.toLocaleString()} prospectos agregados a la blacklist.`, variant: 'success' })
            })
          } catch {
            showInfo({ title: 'Error', message: 'Error al obtener prospectos.', variant: 'error' })
          }
        } else {
          const phones = [...selected].map(id => prospects.find(p => p.id === id)?.phone_number).filter((ph): ph is string => !!ph)
          await sendToBlacklist(phones, () => {
            setSelected(new Set())
            showInfo({ title: 'Blacklist', message: `${phones.length.toLocaleString()} prospectos agregados a la blacklist.`, variant: 'success' })
          })
        }
      },
    })
  }

  // ── Conversión prospect → contacto ────────────────────────────────────────

  const openDetail = (e: React.MouseEvent, p: Prospect) => {
    e.stopPropagation()
    setDetailProspect(p)
    setConvertStep('idle')
    setConvertNotes('')
    setConvertResult(null)
  }

  const closeDetail = () => {
    setDetailProspect(null)
    setConvertStep('idle')
    setConvertNotes('')
    setConvertResult(null)
  }

  const confirmConvert = async () => {
    if (!detailProspect) return
    setConverting(true)
    try {
      const res = await fetchJson<{ contact_id: string; warning?: string }>(
        `/api/prospects/${detailProspect.id}/convert`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes: convertNotes.trim() || null }) }
      )
      setConvertResult(res)
      setConvertStep('done')
      // Refrescar la lista para que el badge cambie
      load()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Error desconocido'
      showInfo({ title: 'Error al convertir', message: msg, variant: 'error' })
    } finally {
      setConverting(false)
    }
  }

  const updateStage = async (newStage: ProspectStage) => {
    if (!detailProspect || updatingStage) return
    setUpdatingStage(true)
    try {
      await fetchJson(`/api/prospects/${detailProspect.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: newStage }),
      })
      // Actualizar el modal y la fila en la tabla sin reload completo
      setDetailProspect(prev => prev ? { ...prev, stage: newStage } : prev)
      setProspects(prev => prev.map(p => p.id === detailProspect.id ? { ...p, stage: newStage } : p))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Error desconocido'
      showInfo({ title: 'Error al actualizar etapa', message: msg, variant: 'error' })
    } finally {
      setUpdatingStage(false)
    }
  }

  // ── Corregir prefijo en batch existente ──────────────────────────────────

  const fixBatchPrefix = () => {
    if (!filterBatch) return
    const batchName = batches.find(b => b.id === filterBatch)?.filename ?? filterBatch.slice(0, 8)
    showConfirm({
      title: 'Corregir números de teléfono',
      message: `Se agregará +549 a todos los números del batch "${batchName}" que no tengan código de Argentina. Esto actualizará hasta ${total.toLocaleString()} prospectos directamente en la base de datos.`,
      confirmLabel: 'Corregir +549',
      variant: 'warning',
      onConfirm: async () => {
        setFixingPrefix(true)
        try {
          const result = await fetchJson<{ fixed: number }>('/api/prospects/fix-prefix', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batch_id: filterBatch, prefix: '+549' }),
          })
          showInfo({ title: 'Corrección completada', message: `${result.fixed.toLocaleString()} números actualizados a formato +549.`, variant: 'success' })
          load()
        } catch {
          showInfo({ title: 'Error', message: 'No se pudieron corregir los números. Intentá de nuevo.', variant: 'error' })
        } finally {
          setFixingPrefix(false)
        }
      },
    })
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  const totalPages = Math.ceil(total / limit)
  // true si todos los de la página actual están seleccionados
  const allCurrentPageSelected = prospects.length > 0 && prospects.every(p => selected.has(p.id))
  // para compatibilidad con código legacy
  const allSelected = allCurrentPageSelected

  return (
    <div className="space-y-4">

      {/* ── Barra de acciones ── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nombre o teléfono…"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            className="pl-9"
          />
        </div>

        <div className="relative min-w-[160px]">
          <Tag className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Filtrar por etiqueta…"
            value={filterTag}
            onChange={e => { setFilterTag(e.target.value.toLowerCase()); setPage(1) }}
            className="pl-8 text-sm"
          />
          {filterTag && (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => { setFilterTag(''); setPage(1) }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <Select value={filterStatus || 'all'} onValueChange={v => { setFilterStatus(!v || v === 'all' ? '' : v); setPage(1) }}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Estado" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los estados</SelectItem>
            <SelectItem value="active">Activos</SelectItem>
            <SelectItem value="converted">Convertidos</SelectItem>
            <SelectItem value="unsubscribed">Dados de baja</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterStage || 'all'} onValueChange={v => { setFilterStage(!v || v === 'all' ? '' : v); setPage(1) }}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Etapa" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas las etapas</SelectItem>
            {(Object.entries(PROSPECT_STAGE_LABELS) as [ProspectStage, string][]).map(([value, label]) => (
              <SelectItem key={value} value={value}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        {batches.length > 0 && (
          <div className="relative" ref={batchMenuRef}>
            <Button
              size="sm" variant="outline"
              onClick={() => setShowBatchMenu(v => !v)}
              className={`max-w-[180px] justify-between ${filterBatch ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-400' : ''}`}
            >
              <span className="truncate text-left flex-1">
                {filterBatch ? (batches.find(b => b.id === filterBatch)?.filename ?? 'Batch') : 'Todos los batches'}
              </span>
              {filterBatch
                ? <X className="ml-1 h-3 w-3 shrink-0 opacity-60 hover:opacity-100" onClick={e => { e.stopPropagation(); setFilterBatch(''); setPage(1) }} />
                : <ChevronDown className="ml-1 h-3 w-3 shrink-0 opacity-60" />
              }
            </Button>
            {showBatchMenu && (
              <div className="absolute left-0 top-full mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg z-30 w-72 py-1 max-h-80 overflow-y-auto">
                <div
                  className={`flex items-center px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer text-sm ${!filterBatch ? 'font-semibold text-indigo-700 dark:text-indigo-400' : 'text-gray-700 dark:text-gray-200'}`}
                  onClick={() => { setFilterBatch(''); setPage(1); setShowBatchMenu(false) }}
                >
                  Todos los batches
                </div>
                <div className="border-t border-gray-100 dark:border-gray-800" />
                {batches.map(b => (
                  <div
                    key={b.id}
                    className={`flex items-center gap-2 px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer group ${filterBatch === b.id ? 'bg-indigo-50 dark:bg-indigo-950/30' : ''}`}
                    onClick={() => { setFilterBatch(b.id); setPage(1); setShowBatchMenu(false) }}
                  >
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm truncate ${filterBatch === b.id ? 'font-semibold text-indigo-700 dark:text-indigo-400' : 'text-gray-700 dark:text-gray-200'}`}>
                        {b.filename ?? 'Sin nombre'}
                      </p>
                      <p className="text-[11px] text-gray-400">{b.imported.toLocaleString()} importados</p>
                    </div>
                    <button
                      className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 hover:text-red-500 p-0.5 rounded disabled:opacity-30"
                      title="Eliminar del historial"
                      disabled={deletingBatchId === b.id}
                      onClick={e => {
                        e.stopPropagation()
                        showConfirm({
                          title: 'Eliminar del historial',
                          message: `Se eliminará "${b.filename ?? 'este batch'}" del historial de importaciones. Los prospectos importados NO se borran.`,
                          confirmLabel: 'Eliminar',
                          variant: 'danger',
                          onConfirm: () => deleteBatch(b.id),
                        })
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>

        <Button variant="outline" size="sm" onClick={() => setBatchHistoryOpen(true)}>
          <History className="h-4 w-4 mr-1" /> Historial
        </Button>

        <Button
          variant="outline" size="sm"
          className="border-teal-200 text-teal-700 hover:bg-teal-50"
          onClick={() => setShowDownloadModal(true)}
          disabled={total === 0}
        >
          <Download className="h-4 w-4 mr-1" /> Descargar
        </Button>

        {filterBatch && (
          <Button
            variant="outline" size="sm"
            onClick={fixBatchPrefix}
            disabled={fixingPrefix}
            className="border-orange-200 text-orange-700 hover:bg-orange-50"
            title="Agregar +549 a los números de este batch que no tengan código de Argentina"
          >
            {fixingPrefix ? 'Corrigiendo…' : 'Corregir +549'}
          </Button>
        )}

        <Button
          size="sm" variant="outline"
          onClick={() => {
            setSelected(new Set(prospects.map(p => p.id)))
            if (total > prospects.length) setSelectAllMode(true)
          }}
          className="border-blue-200 text-blue-700 hover:bg-blue-50"
        >
          <CheckSquare className="h-4 w-4 mr-1" />
          Seleccionar todos
        </Button>

        <div className="relative" ref={listsMenuRef}>
          <Button
            size="sm" variant="outline"
            onClick={() => setShowListsMenu(v => !v)}
            className={`border-indigo-200 text-indigo-700 hover:bg-indigo-50 ${filterList ? 'bg-indigo-50 border-indigo-400' : ''}`}
          >
            <List className="h-4 w-4 mr-1" />
            {filterList ? (prospectLists.find(l => l.id === filterList)?.name ?? 'Lista') : 'Listas'}
            {filterList && (
              <X
                className="ml-1.5 h-3 w-3 opacity-60 hover:opacity-100"
                onClick={e => { e.stopPropagation(); setFilterList(''); setPage(1) }}
              />
            )}
            {!filterList && <ChevronDown className="ml-1 h-3 w-3 opacity-60" />}
          </Button>
          {showListsMenu && (
            <div className="absolute left-0 top-full mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg z-30 w-72 py-1 max-h-80 overflow-y-auto">
              <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-800">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Listas de difusión</span>
              </div>
              {prospectLists.length === 0 && (
                <p className="text-xs text-gray-400 px-3 py-4 text-center">No hay listas creadas</p>
              )}
              {prospectLists.map(l => (
                <div
                  key={l.id}
                  className={`flex items-center gap-2 px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer ${filterList === l.id ? 'bg-indigo-50 dark:bg-indigo-950/30' : ''}`}
                  onClick={() => { setFilterList(l.id); setPage(1); setShowListsMenu(false) }}
                >
                  <Users className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm truncate ${filterList === l.id ? 'font-semibold text-indigo-700 dark:text-indigo-400' : 'text-gray-700 dark:text-gray-200'}`}>{l.name}</p>
                    <p className="text-[11px] text-gray-400">{l.member_count.toLocaleString()} prospectos</p>
                  </div>
                  {filterList === l.id && <Filter className="h-3 w-3 text-indigo-500 shrink-0" />}
                </div>
              ))}
            </div>
          )}
        </div>

        <Button
          size="sm"
          onClick={() => fileRef.current?.click()}
          className="bg-emerald-600 hover:bg-emerald-700 text-white"
        >
          <Upload className="h-4 w-4 mr-1" /> Importar CSV / Excel / VCF
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx,.xls,.txt,.vcf"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = '' }}
        />

        {(selected.size > 0 || selectAllMode) && (
          <>
            {!selectAllMode && (
              <>
                <Button size="sm" variant="outline" onClick={() => { setCreateListOpen(true); setCreateListName(''); setCreateListError(null); setCreateListResult(null) }}>
                  <List className="h-4 w-4 mr-1" /> Crear lista ({selected.size})
                </Button>
                <Button size="sm" variant="outline" onClick={openAddToCampaign}>
                  <Send className="h-4 w-4 mr-1" /> Agregar a campaña ({selected.size})
                </Button>
              </>
            )}
            <Button
              size="sm" variant="outline"
              onClick={blacklistSelected}
              disabled={blacklistSaving}
              className="border-orange-200 text-orange-700 hover:bg-orange-50"
            >
              <Ban className="h-4 w-4 mr-1" />
              {selectAllMode ? `Blacklist todos (${total.toLocaleString()})` : `Blacklist (${selected.size})`}
            </Button>
            <Button size="sm" variant="destructive" onClick={deleteSelected}>
              <Trash2 className="h-4 w-4 mr-1" />
              {selectAllMode ? `Eliminar todos (${total.toLocaleString()})` : `Eliminar (${selected.size})`}
            </Button>
          </>
        )}
      </div>

      {/* ── Banner seleccionar todos ── */}
      {allCurrentPageSelected && !selectAllMode && total > prospects.length && (
        <div className="flex items-center gap-2 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 px-3 py-2 text-sm">
          <span className="text-blue-700 dark:text-blue-300">
            Los {prospects.length} prospectos de esta página están seleccionados.{selected.size > prospects.length ? ` (${selected.size} en total)` : ''}
          </span>
          <button
            type="button"
            className="font-medium text-blue-600 dark:text-blue-400 underline hover:no-underline"
            onClick={() => setSelectAllMode(true)}
          >
            Seleccionar los {total.toLocaleString()} de esta búsqueda
          </button>
        </div>
      )}
      {selectAllMode && (
        <div className="flex items-center gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-sm">
          <span className="text-amber-700 dark:text-amber-300">
            Todos los <strong>{total.toLocaleString()}</strong> prospectos de esta búsqueda están seleccionados.
          </span>
          <button
            type="button"
            className="font-medium text-amber-600 dark:text-amber-400 underline hover:no-underline"
            onClick={() => { setSelectAllMode(false); setSelected(new Set()) }}
          >
            Cancelar
          </button>
        </div>
      )}

      {/* ── Contador ── */}
      <div className="text-sm text-muted-foreground">
        {total.toLocaleString()} prospectos en total
        {selectAllMode
          ? ` · ${total.toLocaleString()} seleccionados (todos)`
          : selected.size > 0 ? ` · ${selected.size} seleccionado${selected.size !== 1 ? 's' : ''} (${selected.size > prospects.length ? 'múltiples páginas' : `pág. ${page}`})` : ''}
      </div>

      {/* ── Tabla ── */}
      <div className="rounded-md border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="rounded"
                />
              </th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Teléfono</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Nombre</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Email</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Estado</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Etapa</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Origen</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Alta</th>
              <th className="w-10 px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && (
              <tr>
                <td colSpan={9} className="py-12 text-center text-muted-foreground">
                  Cargando…
                </td>
              </tr>
            )}
            {!loading && !prospects.length && (
              <tr>
                <td colSpan={9} className="py-12 text-center text-muted-foreground">
                  No hay prospectos.{' '}
                  <button
                    className="text-emerald-600 underline"
                    onClick={() => fileRef.current?.click()}
                  >
                    Importar CSV
                  </button>
                </td>
              </tr>
            )}
            {prospects.map(p => (
              <tr
                key={p.id}
                className={`hover:bg-muted/30 cursor-pointer ${selected.has(p.id) ? 'bg-emerald-50' : ''}`}
                onClick={() => toggleSelect(p.id)}
              >
                <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(p.id)}
                    onChange={() => toggleSelect(p.id)}
                    className="rounded"
                  />
                </td>
                <td className="px-3 py-2 font-mono text-xs">{p.phone_number}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    <span>
                      {[p.first_name, p.last_name].filter(Boolean).join(' ') || (
                        <span className="text-muted-foreground italic">sin nombre</span>
                      )}
                    </span>
                    {(p.tags ?? []).length > 0 && (
                      <div className="flex flex-wrap gap-1" onClick={e => e.stopPropagation()}>
                        {(p.tags ?? []).map(t => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => { setFilterTag(t); setPage(1) }}
                            className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium border transition-colors cursor-pointer hover:bg-indigo-100 ${filterTag === t ? 'bg-indigo-200 border-indigo-400 text-indigo-800' : 'bg-indigo-50 text-indigo-600 border-indigo-200'}`}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{p.email ?? '—'}</td>
                <td className="px-3 py-2">
                  <Badge
                    variant={p.status === 'active' ? 'default' : 'secondary'}
                    className={`text-xs ${p.status === 'converted' ? 'bg-blue-100 text-blue-700 border-blue-200' : ''}`}
                  >
                    {p.status === 'active' ? 'Activo' : p.status === 'converted' ? 'Convertido' : 'Dado de baja'}
                  </Badge>
                </td>
                <td className="px-3 py-2"><StageBadge stage={p.stage} /></td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{p.source}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {new Date(p.created_at).toLocaleDateString('es-AR')}
                </td>
                <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                  <Button
                    variant="ghost" size="sm"
                    className="h-7 w-7 p-0"
                    onClick={e => openDetail(e, p)}
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Paginación ── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Página {page} de {totalPages}
          </span>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* ── Modal importación ── */}
      <Dialog open={importOpen} onOpenChange={v => { if (!importing) setImportOpen(v) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Importar prospectos — {importFilename}</DialogTitle>
          </DialogHeader>

          {!importResult ? (
            <>
              <div className="space-y-3 py-2">
                <div className="flex items-center gap-3 rounded-lg bg-muted/50 px-4 py-3">
                  <div className="text-2xl font-bold text-emerald-600">{parsedRows.length.toLocaleString()}</div>
                  <div className="text-sm text-muted-foreground">filas detectadas listas para importar</div>
                </div>

                {parsedRows.length > 0 && (
                  <div className="rounded-md border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="px-3 py-1.5 text-left">Teléfono</th>
                          <th className="px-3 py-1.5 text-left">Nombre</th>
                          <th className="px-3 py-1.5 text-left">Email</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {parsedRows.slice(0, 5).map((r, i) => {
                          const needsFix = autoPrefix && !r.phone.startsWith('+54')
                          const displayPhone = needsFix ? autoPrefix + r.phone.slice(1) : r.phone
                          const hasRepeat = autoNumber && repeatName && r.first_name?.trim() === repeatName
                          const hasManual = manualPrefix.trim() && !(r.first_name ?? '').trim()
                          const displayName = hasRepeat
                            ? `${repeatName} ${i + 1}`
                            : hasManual
                              ? `${manualPrefix.trim()} ${i + 1}`
                              : r.first_name
                          return (
                            <tr key={i}>
                              <td className="px-3 py-1.5 font-mono">
                                {needsFix
                                  ? <span className="text-emerald-600 font-medium">{displayPhone}</span>
                                  : r.phone}
                              </td>
                              <td className="px-3 py-1.5">
                                {(hasRepeat || hasManual)
                                  ? <span className="text-indigo-600 font-medium">{displayName}</span>
                                  : [displayName, r.last_name].filter(Boolean).join(' ') || '—'}
                              </td>
                              <td className="px-3 py-1.5 text-muted-foreground">{r.email || '—'}</td>
                            </tr>
                          )
                        })}
                        {parsedRows.length > 5 && (
                          <tr>
                            <td colSpan={3} className="px-3 py-1.5 text-muted-foreground text-center">
                              … y {(parsedRows.length - 5).toLocaleString()} filas más
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* ── Sugerencia de prefijo argentino ── */}
                {(() => {
                  const needsCount = parsedRows.filter(r => !r.phone.startsWith('+54')).length
                  if (!needsCount) return null
                  const example = parsedRows.find(r => !r.phone.startsWith('+54'))
                  return (
                    <div className={`rounded-md border px-4 py-3 text-sm space-y-2 ${
                      autoPrefix
                        ? 'bg-emerald-50 border-emerald-200 dark:bg-emerald-950/20 dark:border-emerald-800'
                        : 'bg-amber-50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-800'
                    }`}>
                      {autoPrefix ? (
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
                            <CheckCircle className="h-4 w-4 shrink-0" />
                            <span>
                              <strong>{needsCount.toLocaleString()}</strong> números recibirán el prefijo{' '}
                              <span className="font-mono font-medium">{autoPrefix}</span>
                            </span>
                          </div>
                          <button
                            type="button"
                            className="text-xs text-muted-foreground underline hover:no-underline"
                            onClick={() => setAutoPrefix('')}
                          >
                            Quitar
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
                            <AlertTriangle className="h-4 w-4 shrink-0" />
                            <span>
                              <strong>{needsCount.toLocaleString()}</strong> números no tienen código de Argentina (+54)
                            </span>
                          </div>
                          {example && (
                            <p className="text-xs text-muted-foreground">
                              Ej: <span className="font-mono">{example.phone}</span>
                              {' → '}
                              <span className="font-mono text-emerald-600">+549{example.phone.slice(1)}</span>
                            </p>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-400 dark:hover:bg-amber-950/40"
                            onClick={() => setAutoPrefix('+549')}
                          >
                            Agregar característica +549 automáticamente
                          </Button>
                        </>
                      )}
                    </div>
                  )
                })()}

                {/* ── Nombre base cuando la mayoría no tiene nombre ── */}
                {mostlyNoNames && !repeatName && (
                  <div className="rounded-md border border-indigo-200 bg-indigo-50 dark:bg-indigo-950/20 dark:border-indigo-800 px-4 py-3 text-sm space-y-2">
                    <div className="flex items-center gap-1.5 text-indigo-700 dark:text-indigo-300">
                      <UserPlus className="h-4 w-4 shrink-0" />
                      <span>La mayoría de contactos no tiene nombre. Podés asignar un nombre base para numerarlos.</span>
                    </div>
                    <div className="flex gap-2 items-center">
                      <Input
                        placeholder="Ej: Trebol"
                        value={manualPrefix}
                        onChange={e => setManualPrefix(e.target.value)}
                        className="h-8 text-sm flex-1"
                      />
                      {manualPrefix.trim() && (
                        <button
                          type="button"
                          className="text-xs text-muted-foreground underline hover:no-underline"
                          onClick={() => setManualPrefix('')}
                        >
                          Quitar
                        </button>
                      )}
                    </div>
                    {manualPrefix.trim() && (
                      <p className="text-xs text-indigo-600 dark:text-indigo-400">
                        Se importarán como{' '}
                        <span className="font-mono">{manualPrefix.trim()} 1</span>,{' '}
                        <span className="font-mono">{manualPrefix.trim()} 2</span>,{' '}
                        <span className="font-mono">{manualPrefix.trim()} 3</span>…
                      </p>
                    )}
                  </div>
                )}

                {/* ── Numeración automática cuando todos tienen el mismo nombre ── */}
                {repeatName && (
                  <div className={`rounded-md border px-4 py-3 text-sm space-y-2 ${
                    autoNumber
                      ? 'bg-indigo-50 border-indigo-200 dark:bg-indigo-950/20 dark:border-indigo-800'
                      : 'bg-gray-50 border-gray-200 dark:bg-gray-800/30 dark:border-gray-700'
                  }`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className={`flex items-center gap-1.5 ${autoNumber ? 'text-indigo-700 dark:text-indigo-300' : 'text-gray-600 dark:text-gray-400'}`}>
                        {autoNumber
                          ? <CheckCircle className="h-4 w-4 shrink-0" />
                          : <AlertTriangle className="h-4 w-4 shrink-0" />}
                        <span>
                          Todos los contactos tienen el nombre{' '}
                          <span className="font-mono font-medium">{repeatName}</span>
                        </span>
                      </div>
                      <button
                        type="button"
                        className={`text-xs underline hover:no-underline shrink-0 ${autoNumber ? 'text-muted-foreground' : 'text-indigo-600 dark:text-indigo-400 font-medium'}`}
                        onClick={() => setAutoNumber(v => !v)}
                      >
                        {autoNumber ? 'Quitar numeración' : 'Numerar'}
                      </button>
                    </div>
                    {autoNumber && (
                      <p className="text-xs text-indigo-600 dark:text-indigo-400">
                        Se importarán como{' '}
                        <span className="font-mono">{repeatName} 1</span>,{' '}
                        <span className="font-mono">{repeatName} 2</span>,{' '}
                        <span className="font-mono">{repeatName} 3</span>…
                      </p>
                    )}
                  </div>
                )}
              </div>

              {importing && (
                <div className="px-1 pb-2 space-y-1">
                  <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-emerald-500 h-2 rounded-full transition-all duration-300"
                      style={{ width: `${importProgress}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground text-center">{importProgress}% — procesando {parsedRows.length.toLocaleString()} registros…</p>
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setImportOpen(false)} disabled={importing}>Cancelar</Button>
                <Button
                  onClick={confirmImport}
                  disabled={importing || !parsedRows.length}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  {importing ? `Importando… ${importProgress}%` : `Importar ${parsedRows.length.toLocaleString()} registros`}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <div className="space-y-3 py-2">
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3">
                    <CheckCircle className="h-5 w-5 text-emerald-600 shrink-0" />
                    <div>
                      <div className="text-xl font-bold text-emerald-700">{importResult.imported.toLocaleString()}</div>
                      <div className="text-xs text-emerald-600">importados</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 rounded-lg bg-muted/50 border px-4 py-3">
                    <XCircle className="h-5 w-5 text-muted-foreground shrink-0" />
                    <div>
                      <div className="text-xl font-bold">{(importResult.skipped_duplicates + importResult.skipped_invalid).toLocaleString()}</div>
                      <div className="text-xs text-muted-foreground">omitidos ({importResult.skipped_duplicates} dup · {importResult.skipped_invalid} inv)</div>
                    </div>
                  </div>
                </div>

                {importResult.warned_existing_contacts > 0 && (
                  <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3">
                    <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                    <div className="text-sm text-amber-800">
                      <strong>{importResult.warned_existing_contacts} teléfono(s)</strong> ya existen como contactos activos.
                      {importResult.warnings.length > 0 && (
                        <div className="mt-1 text-xs font-mono opacity-70">
                          {importResult.warnings.slice(0, 5).join(', ')}
                          {importResult.warnings.length > 5 && ` y ${importResult.warnings.length - 5} más…`}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <DialogFooter>
                <Button onClick={() => { setImportOpen(false); setImportResult(null); setParsedRows([]) }}>
                  Cerrar
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Modal agregar a campaña ── */}
      <Dialog open={addCampaignOpen} onOpenChange={v => { if (!addingToCampaign) setAddCampaignOpen(v) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Agregar {selected.size} prospecto(s) a campaña</DialogTitle>
          </DialogHeader>

          {!addResult ? (
            <>
              <div className="py-2 space-y-3">
                <p className="text-sm text-muted-foreground">
                  Los prospectos seleccionados se agregarán como destinatarios de la campaña elegida.
                  Solo se incluyen los que tienen opt-in activo y no están en la blacklist.
                </p>
                <Select value={selectedCampaign} onValueChange={v => setSelectedCampaign(v ?? '')}>
                  <SelectTrigger>
                    <SelectValue placeholder="Seleccionar campaña…" />
                  </SelectTrigger>
                  <SelectContent>
                    {campaigns.map(c => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                        <span className="ml-2 text-xs text-muted-foreground capitalize">({c.status})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setAddCampaignOpen(false)}>Cancelar</Button>
                <Button
                  onClick={confirmAddToCampaign}
                  disabled={!selectedCampaign || addingToCampaign}
                >
                  {addingToCampaign ? 'Agregando…' : 'Confirmar'}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <div className="py-4 space-y-2">
                <div className="flex items-center gap-2 text-emerald-700">
                  <CheckCircle className="h-5 w-5" />
                  <span className="font-medium">{addResult.added} prospecto(s) agregados a la campaña.</span>
                </div>
                {addResult.already > 0 && (
                  <p className="text-sm text-muted-foreground">
                    {addResult.already} ya estaban en la campaña (omitidos).
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button onClick={() => { setAddCampaignOpen(false); setAddResult(null) }}>Cerrar</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Modal crear lista de difusión ── */}
      <Dialog open={createListOpen} onOpenChange={v => { if (!creatingList) setCreateListOpen(v) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Crear lista con {selected.size} prospecto(s)</DialogTitle>
          </DialogHeader>

          {!createListResult ? (
            <>
              <div className="py-2 space-y-3">
                <p className="text-sm text-muted-foreground">
                  Se creará una nueva lista de difusión con los prospectos seleccionados.
                </p>
                <Input
                  placeholder="Nombre de la lista…"
                  value={createListName}
                  onChange={e => setCreateListName(e.target.value)}
                  disabled={creatingList}
                />
                {createListError && (
                  <p className="text-sm text-destructive">{createListError}</p>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateListOpen(false)} disabled={creatingList}>Cancelar</Button>
                <Button onClick={createListFromProspects} disabled={!createListName.trim() || creatingList}>
                  {creatingList ? 'Creando…' : 'Crear lista'}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <div className="py-4 space-y-2">
                <div className="flex items-center gap-2 text-emerald-700">
                  <CheckCircle className="h-5 w-5" />
                  <span className="font-medium">Lista creada con {createListResult.member_count} prospecto(s).</span>
                </div>
              </div>
              <DialogFooter>
                <Button onClick={() => { setCreateListOpen(false); setCreateListResult(null) }}>Cerrar</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Modal historial de batches ── */}
      <Dialog open={batchHistoryOpen} onOpenChange={setBatchHistoryOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Historial de importaciones</DialogTitle>
          </DialogHeader>
          <div className="overflow-auto max-h-96">
            {batches.length === 0 ? (
              <p className="text-center py-8 text-muted-foreground">Sin importaciones registradas.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-muted/50 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left">Archivo</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2 text-right">Importados</th>
                    <th className="px-3 py-2 text-right">Dup</th>
                    <th className="px-3 py-2 text-right">Inválidos</th>
                    <th className="px-3 py-2 text-left">Fecha</th>
                    <th className="w-8 px-2 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {batches.map(b => (
                    <tr key={b.id} className="hover:bg-muted/30 group">
                      <td className="px-3 py-2 font-medium">{b.filename ?? '—'}</td>
                      <td className="px-3 py-2 text-right">{b.total_rows.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right text-emerald-600 font-medium">{b.imported.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{b.skipped_duplicates.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{b.skipped_invalid.toLocaleString()}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {new Date(b.created_at).toLocaleString('es-AR')}
                      </td>
                      <td className="px-2 py-2">
                        <button
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-red-500 disabled:opacity-30"
                          title="Eliminar registro del historial"
                          disabled={deletingBatchId === b.id}
                          onClick={() => showConfirm({
                            title: 'Eliminar del historial',
                            message: `Se eliminará "${b.filename ?? 'este batch'}" del historial de importaciones. Los prospectos importados NO se borran.`,
                            confirmLabel: 'Eliminar',
                            variant: 'danger',
                            onConfirm: () => deleteBatch(b.id),
                          })}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchHistoryOpen(false)}>Cerrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Modal detalle + conversión ── */}
      <Dialog open={!!detailProspect} onOpenChange={open => { if (!open && !converting) closeDetail() }}>
        <DialogContent className="max-w-md">
          {detailProspect && convertStep === 'idle' && (
            <>
              <DialogHeader>
                <DialogTitle>Detalle del prospecto</DialogTitle>
              </DialogHeader>

              <div className="space-y-3 py-2 text-sm">
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  <span className="text-muted-foreground">Teléfono</span>
                  <span className="font-mono">{detailProspect.phone_number}</span>

                  <span className="text-muted-foreground">Nombre</span>
                  <span>{[detailProspect.first_name, detailProspect.last_name].filter(Boolean).join(' ') || '—'}</span>

                  <span className="text-muted-foreground">Email</span>
                  <span>{detailProspect.email ?? '—'}</span>

                  <span className="text-muted-foreground">Estado</span>
                  <span>
                    <Badge
                      variant={detailProspect.status === 'active' ? 'default' : 'secondary'}
                      className={`text-xs ${detailProspect.status === 'converted' ? 'bg-blue-100 text-blue-700 border-blue-200' : ''}`}
                    >
                      {detailProspect.status === 'active' ? 'Activo'
                        : detailProspect.status === 'converted' ? 'Convertido' : 'Dado de baja'}
                    </Badge>
                  </span>

                  <span className="text-muted-foreground">Etapa</span>
                  <span>
                    <Select
                      value={detailProspect.stage ?? 'nuevo'}
                      onValueChange={v => updateStage(v as ProspectStage)}
                      disabled={updatingStage || detailProspect.status !== 'active'}
                    >
                      <SelectTrigger className="h-7 text-xs w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(PROSPECT_STAGE_LABELS) as ProspectStage[]).map(s => (
                          <SelectItem key={s} value={s} className="text-xs">
                            {PROSPECT_STAGE_LABELS[s]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </span>

                  <span className="text-muted-foreground">Opt-in</span>
                  <span>{detailProspect.opt_in ? 'Sí' : 'No'}</span>

                  <span className="text-muted-foreground">Origen</span>
                  <span>{detailProspect.source}</span>

                  <span className="text-muted-foreground">Batch</span>
                  <span className="font-mono text-xs text-muted-foreground truncate">
                    {detailProspect.import_batch_id ?? '—'}
                  </span>

                  <span className="text-muted-foreground">Alta</span>
                  <span>{new Date(detailProspect.created_at).toLocaleString('es-AR')}</span>
                </div>

                {detailProspect.notes && (
                  <div className="rounded-md bg-muted/50 px-3 py-2 text-sm">
                    <span className="text-muted-foreground block text-xs mb-1">Notas</span>
                    {detailProspect.notes}
                  </div>
                )}

                {detailProspect.converted_to_contact_id && (
                  <div className="rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-sm text-blue-700">
                    Convertido al contacto{' '}
                    <span className="font-mono text-xs">{detailProspect.converted_to_contact_id}</span>
                  </div>
                )}

                {/* Editor de etiquetas */}
                <div className="space-y-2">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                    <Tag className="h-3 w-3" /> Etiquetas
                  </span>
                  <div className="flex flex-wrap gap-1.5 min-h-[24px]">
                    {(detailProspect.tags ?? []).map(t => (
                      <span key={t} className="inline-flex items-center gap-1 text-xs bg-indigo-50 border border-indigo-200 text-indigo-700 px-2 py-0.5 rounded-full">
                        {t}
                        <button type="button" onClick={() => removeProspectTag(t)} className="hover:text-indigo-900">
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    ))}
                    {(detailProspect.tags ?? []).length === 0 && (
                      <span className="text-xs text-muted-foreground italic">Sin etiquetas</span>
                    )}
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      className="flex-1 text-xs border border-input rounded-md px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="Nueva etiqueta…"
                      value={tagsInput}
                      onChange={e => setTagsInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addProspectTag() } }}
                      maxLength={50}
                    />
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={addProspectTag} disabled={!tagsInput.trim()}>
                      Agregar
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={saveProspectTags} disabled={tagsSaving}>
                      {tagsSaving ? '…' : 'Guardar'}
                    </Button>
                  </div>
                </div>
              </div>

              <DialogFooter className="gap-2 flex-wrap">
                <Button
                  variant="outline"
                  onClick={() => blacklistProspect(detailProspect)}
                  disabled={blacklistSaving}
                  className="border-orange-200 text-orange-700 hover:bg-orange-50"
                >
                  <Ban className="h-4 w-4 mr-1" /> Blacklist
                </Button>
                <Button variant="outline" onClick={closeDetail}>Cerrar</Button>
                {detailProspect.status === 'active' && !detailProspect.converted_to_contact_id && (
                  <Button
                    onClick={() => setConvertStep('confirm')}
                    className="bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    <UserPlus className="h-4 w-4 mr-1" /> Convertir a contacto
                  </Button>
                )}
              </DialogFooter>
            </>
          )}

          {detailProspect && convertStep === 'confirm' && (
            <>
              <DialogHeader>
                <DialogTitle>Convertir a contacto</DialogTitle>
              </DialogHeader>

              <div className="space-y-4 py-2">
                <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-3 text-sm text-amber-800 flex gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>
                    Esta acción es <strong>irreversible</strong>. El prospecto pasará a estado{' '}
                    <em>Convertido</em> y se creará un contacto en el CRM con su número de teléfono.
                  </span>
                </div>

                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Notas para el nuevo contacto (opcional)</p>
                  <Textarea
                    placeholder="Ej: Convertido desde campaña de captación Q2..."
                    value={convertNotes}
                    onChange={e => setConvertNotes(e.target.value)}
                    rows={3}
                  />
                </div>

                <div className="text-sm text-muted-foreground">
                  <span className="font-medium">Prospecto:</span>{' '}
                  {[detailProspect.first_name, detailProspect.last_name].filter(Boolean).join(' ') || detailProspect.phone_number}
                </div>
              </div>

              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setConvertStep('idle')} disabled={converting}>
                  Volver
                </Button>
                <Button
                  onClick={confirmConvert}
                  disabled={converting}
                  className="bg-blue-600 hover:bg-blue-700 text-white"
                >
                  {converting ? 'Convirtiendo…' : 'Confirmar conversión'}
                </Button>
              </DialogFooter>
            </>
          )}

          {detailProspect && convertStep === 'done' && convertResult && (
            <>
              <DialogHeader>
                <DialogTitle>Conversión completada</DialogTitle>
              </DialogHeader>

              <div className="space-y-3 py-2">
                <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-emerald-700">
                  <CheckCircle className="h-5 w-5 shrink-0" />
                  <div>
                    <p className="font-medium">Contacto creado exitosamente</p>
                    <p className="text-xs font-mono mt-0.5 opacity-70">{convertResult.contact_id}</p>
                  </div>
                </div>

                {convertResult.warning && (
                  <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-3 text-amber-800 text-sm">
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                    {convertResult.warning}
                  </div>
                )}
              </div>

              <DialogFooter>
                <Button onClick={closeDetail}>Cerrar</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Diálogo de confirmación estilizado ── */}
      {confirmDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setConfirmDialog(null)} />
          <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className={`h-1.5 w-full ${confirmDialog.variant === 'danger' ? 'bg-red-500' : 'bg-orange-400'}`} />
            <div className="px-6 py-5 space-y-3">
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{confirmDialog.title}</h2>
              <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{confirmDialog.message}</p>
            </div>
            <div className="flex items-center justify-end gap-2 px-6 py-4 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-100 dark:border-gray-700">
              <Button variant="outline" size="sm" onClick={() => setConfirmDialog(null)}>Cancelar</Button>
              <Button
                size="sm"
                className={confirmDialog.variant === 'danger' ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-orange-500 hover:bg-orange-600 text-white'}
                onClick={() => { setConfirmDialog(null); confirmDialog.onConfirm() }}
              >
                {confirmDialog.confirmLabel ?? 'Confirmar'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Diálogo de información / resultado ── */}
      {infoDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setInfoDialog(null)} />
          <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className={`h-1.5 w-full ${
              infoDialog.variant === 'success' ? 'bg-emerald-500' :
              infoDialog.variant === 'error'   ? 'bg-red-500' : 'bg-blue-500'
            }`} />
            <div className="px-6 py-5 space-y-2">
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{infoDialog.title}</h2>
              <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{infoDialog.message}</p>
            </div>
            <div className="flex justify-end px-6 py-4 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-100 dark:border-gray-700">
              <Button size="sm" onClick={() => setInfoDialog(null)}>Cerrar</Button>
            </div>
          </div>
        </div>
      )}

      <DownloadContactsModal
        open={showDownloadModal}
        onClose={() => setShowDownloadModal(false)}
        contactCount={total}
        fetchParams={new URLSearchParams({
          q:        search,
          status:   filterStatus,
          stage:    filterStage,
          batch_id: filterBatch,
          list_id:  filterList,
        })}
        apiEndpoint="/api/prospects"
        filenameHint={
          filterList
            ? (prospectLists.find(l => l.id === filterList)?.name ?? 'lista').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')
            : filterBatch
              ? (batches.find(b => b.id === filterBatch)?.filename ?? 'batch').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')
              : 'todos'
        }
      />

    </div>
  )
}
