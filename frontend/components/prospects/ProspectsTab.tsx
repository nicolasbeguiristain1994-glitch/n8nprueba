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
} from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { fetchJson } from '@/lib/fetchJson'
import type { Prospect, ProspectImportBatch, ProspectImportResult } from '@/lib/prospects'

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
  const [page, setPage]             = useState(1)
  const limit = 50

  // ── Selección
  const [selected, setSelected]     = useState<Set<string>>(new Set())

  // ── Modal importación
  const [importOpen, setImportOpen]       = useState(false)
  const [parsedRows, setParsedRows]       = useState<ParsedRow[]>([])
  const [importFilename, setImportFilename] = useState('')
  const [importing, setImporting]         = useState(false)
  const [importProgress, setImportProgress] = useState(0)   // 0-100
  const [importResult, setImportResult]   = useState<ProspectImportResult | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // ── Modal agregar a campaña
  const [addCampaignOpen, setAddCampaignOpen]   = useState(false)
  const [selectedCampaign, setSelectedCampaign] = useState('')
  const [addingToCampaign, setAddingToCampaign] = useState(false)
  const [addResult, setAddResult]               = useState<{ added: number; already: number } | null>(null)

  // ── Modal historial de batches
  const [batchHistoryOpen, setBatchHistoryOpen] = useState(false)

  // ── Modal detalle + conversión
  const [detailProspect, setDetailProspect]   = useState<Prospect | null>(null)
  const [convertStep, setConvertStep]         = useState<'idle' | 'confirm' | 'done'>('idle')
  const [convertNotes, setConvertNotes]       = useState('')
  const [converting, setConverting]           = useState(false)
  const [convertResult, setConvertResult]     = useState<{ contact_id: string; warning?: string } | null>(null)

  // ── Carga ─────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true)
    setSelected(new Set())
    try {
      const q = new URLSearchParams({
        q:        search,
        page:     String(page),
        limit:    String(limit),
        batch_id: filterBatch,
        status:   filterStatus,
      })
      const data = await fetchJson<{ prospects: Prospect[]; total: number }>(`/api/prospects?${q}`)
      setProspects(data.prospects ?? [])
      setTotal(data.total ?? 0)
    } finally {
      setLoading(false)
    }
  }, [search, page, filterBatch, filterStatus])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    fetchJson<{ batches: ProspectImportBatch[] }>('/api/prospects/batches')
      .then(d => setBatches(d.batches ?? []))
      .catch(() => {})
  }, [])

  // ── Selección ─────────────────────────────────────────────────────────────

  const toggleSelect = (id: string) =>
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const toggleAll = () =>
    setSelected(prev =>
      prev.size === prospects.length
        ? new Set()
        : new Set(prospects.map(p => p.id))
    )

  // ── Delete ────────────────────────────────────────────────────────────────

  const deleteSelected = async () => {
    if (!selected.size) return
    if (!confirm(`¿Eliminar ${selected.size} prospecto(s)?`)) return
    await Promise.all([...selected].map(id => fetchJson(`/api/prospects/${id}`, { method: 'DELETE' }).catch(() => {})))
    load()
  }

  // ── Parse archivo ─────────────────────────────────────────────────────────

  const handleFile = async (file: File) => {
    setImportFilename(file.name)
    setImportResult(null)
    setParsedRows([])

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
    }

    setParsedRows(rows.filter(r => r.phone.length > 2))
    setImportOpen(true)
  }

  // ── Confirmar importación (chunked para archivos grandes) ────────────────────

  const CHUNK_SIZE = 5_000

  const confirmImport = async () => {
    if (!parsedRows.length) return
    setImporting(true)
    setImportProgress(0)

    const allRows = parsedRows.map(r => ({ phone: r.phone, first_name: r.first_name, last_name: r.last_name, email: r.email }))
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
      alert(`Error al convertir: ${msg}`)
    } finally {
      setConverting(false)
    }
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  const totalPages = Math.ceil(total / limit)
  const allSelected = prospects.length > 0 && selected.size === prospects.length

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

        <Select value={filterStatus || 'all'} onValueChange={v => { setFilterStatus(!v || v === 'all' ? '' : v); setPage(1) }}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Todos" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            <SelectItem value="active">Activos</SelectItem>
            <SelectItem value="converted">Convertidos</SelectItem>
            <SelectItem value="unsubscribed">Dados de baja</SelectItem>
          </SelectContent>
        </Select>

        {batches.length > 0 && (
          <Select value={filterBatch} onValueChange={v => { setFilterBatch(v === 'all' || !v ? '' : v); setPage(1) }}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Todos los batches" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los batches</SelectItem>
              {batches.slice(0, 20).map(b => (
                <SelectItem key={b.id} value={b.id}>
                  {b.filename ?? 'Sin nombre'} ({b.imported})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>

        <Button variant="outline" size="sm" onClick={() => setBatchHistoryOpen(true)}>
          <History className="h-4 w-4 mr-1" /> Historial
        </Button>

        <Button
          size="sm"
          onClick={() => fileRef.current?.click()}
          className="bg-emerald-600 hover:bg-emerald-700 text-white"
        >
          <Upload className="h-4 w-4 mr-1" /> Importar CSV / Excel
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx,.xls,.txt"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = '' }}
        />

        {selected.size > 0 && (
          <>
            <Button size="sm" variant="outline" onClick={openAddToCampaign}>
              <Send className="h-4 w-4 mr-1" /> Agregar a campaña ({selected.size})
            </Button>
            <Button size="sm" variant="destructive" onClick={deleteSelected}>
              <Trash2 className="h-4 w-4 mr-1" /> Eliminar ({selected.size})
            </Button>
          </>
        )}
      </div>

      {/* ── Contador ── */}
      <div className="text-sm text-muted-foreground">
        {total.toLocaleString()} prospectos en total
        {selected.size > 0 && ` · ${selected.size} seleccionados`}
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
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Origen</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Alta</th>
              <th className="w-10 px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && (
              <tr>
                <td colSpan={8} className="py-12 text-center text-muted-foreground">
                  Cargando…
                </td>
              </tr>
            )}
            {!loading && !prospects.length && (
              <tr>
                <td colSpan={8} className="py-12 text-center text-muted-foreground">
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
                  {[p.first_name, p.last_name].filter(Boolean).join(' ') || (
                    <span className="text-muted-foreground italic">sin nombre</span>
                  )}
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
                        {parsedRows.slice(0, 5).map((r, i) => (
                          <tr key={i}>
                            <td className="px-3 py-1.5 font-mono">{r.phone}</td>
                            <td className="px-3 py-1.5">{[r.first_name, r.last_name].filter(Boolean).join(' ') || '—'}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">{r.email || '—'}</td>
                          </tr>
                        ))}
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
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {batches.map(b => (
                    <tr key={b.id} className="hover:bg-muted/30">
                      <td className="px-3 py-2 font-medium">{b.filename ?? '—'}</td>
                      <td className="px-3 py-2 text-right">{b.total_rows.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right text-emerald-600 font-medium">{b.imported.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{b.skipped_duplicates.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{b.skipped_invalid.toLocaleString()}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {new Date(b.created_at).toLocaleString('es-AR')}
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

                {detailProspect.tags?.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {detailProspect.tags.map(t => (
                      <Badge key={t} variant="outline" className="text-xs">{t}</Badge>
                    ))}
                  </div>
                )}
              </div>

              <DialogFooter className="gap-2">
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

    </div>
  )
}
