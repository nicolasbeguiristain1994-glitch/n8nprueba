'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import * as XLSX from 'xlsx'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ShieldOff, Search, Plus, Upload, Download, Trash2, RefreshCw, AlertTriangle, X } from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface BlacklistItem {
  id: string
  phone_number_raw: string
  phone_number_normalized: string
  reason: string | null
  source: 'manual' | 'automatic' | 'import'
  added_by_name: string | null
  added_at: string
  removed_at: string | null
  removed_by_name: string | null
}

const SOURCE_LABELS: Record<string, string> = {
  manual:    'Manual',
  automatic: 'Automático',
  import:    'Importado',
}

const SOURCE_COLORS: Record<string, string> = {
  manual:    'bg-blue-100 text-blue-800',
  automatic: 'bg-orange-100 text-orange-800',
  import:    'bg-purple-100 text-purple-800',
}

function formatPhone(normalized: string): string {
  if (!normalized) return ''
  return '+' + normalized
}

function formatDate(iso: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// ── Página principal ──────────────────────────────────────────────────────────

export default function BlacklistPage() {
  const [items, setItems]     = useState<BlacklistItem[]>([])
  const [total, setTotal]     = useState(0)
  const [page, setPage]       = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)

  // Filtros
  const [q, setQ]           = useState('')
  const [source, setSource] = useState('all')
  const [status, setStatus] = useState('active')

  // Modal: agregar manual
  const [showAdd, setShowAdd]       = useState(false)
  const [addPhones, setAddPhones]   = useState('')
  const [addReason, setAddReason]   = useState('')
  const [addLoading, setAddLoading] = useState(false)
  const [addError, setAddError]     = useState<string | null>(null)
  const [addSuccess, setAddSuccess] = useState<string | null>(null)

  // Modal: importar
  const [showImport, setShowImport]         = useState(false)
  const [importPhones, setImportPhones]     = useState<string[]>([])
  const [importFileName, setImportFileName] = useState('')
  const [importReason, setImportReason]     = useState('Importación masiva')
  const [importPreview, setImportPreview]   = useState<{ inserted: number; skipped: number; invalid: number } | null>(null)
  const [importLoading, setImportLoading]   = useState(false)
  const [importError, setImportError]       = useState<string | null>(null)
  const [importSuccess, setImportSuccess]   = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Modal: confirmar eliminación
  const [deleteTarget, setDeleteTarget] = useState<BlacklistItem | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteError, setDeleteError]   = useState<string | null>(null)

  const limit = 50

  // ── Fetch ────────────────────────────────────────────────────────────────────

  const fetchItems = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        page: String(page),
        status,
        ...(source !== 'all' ? { source } : {}),
        ...(q ? { q } : {}),
      })
      const data = await fetchJson<{ items: BlacklistItem[]; total: number }>(
        `/api/blacklist?${params}`,
      )
      setItems(data.items)
      setTotal(data.total)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cargar la blacklist')
    } finally {
      setLoading(false)
    }
  }, [page, status, source, q])

  useEffect(() => { void fetchItems() }, [fetchItems])

  // ── Agregar manual ────────────────────────────────────────────────────────────

  async function handleAdd() {
    setAddError(null)
    setAddSuccess(null)
    if (!addPhones.trim()) {
      setAddError('Ingresá al menos un número')
      return
    }
    setAddLoading(true)
    try {
      const res = await fetchJson<{ inserted: number; skipped: number; invalid: string[]; invalid_count: number }>(
        '/api/blacklist',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phones: addPhones, reason: addReason || 'Sin motivo especificado' }),
        },
      )
      setAddSuccess(
        `${res.inserted} número(s) agregado(s)` +
        (res.skipped > 0 ? `, ${res.skipped} ya estaban en blacklist` : '') +
        (res.invalid_count > 0 ? `, ${res.invalid_count} inválido(s)` : ''),
      )
      setAddPhones('')
      setAddReason('')
      void fetchItems()
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Error al agregar')
    } finally {
      setAddLoading(false)
    }
  }

  // ── Importar archivo ──────────────────────────────────────────────────────────

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImportFileName(file.name)
    setImportPreview(null)
    setImportError(null)
    setImportSuccess(null)

    const lower = file.name.toLowerCase()
    if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.ods')) {
      const reader = new FileReader()
      reader.onload = (ev) => {
        const data = ev.target?.result
        if (!data) return
        const wb = XLSX.read(data, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const rows = XLSX.utils.sheet_to_json<unknown>(ws, { header: 1 }) as unknown[][]
        const phones: string[] = []
        for (const row of rows) {
          if (!Array.isArray(row)) continue
          const val = row[0]
          if (val != null && String(val).trim()) {
            phones.push(String(val).trim())
          }
        }
        setImportPhones(phones)
      }
      reader.readAsArrayBuffer(file)
    } else {
      // CSV / TXT
      const reader = new FileReader()
      reader.onload = (ev) => {
        const text = ev.target?.result as string
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
        setImportPhones(lines)
      }
      reader.readAsText(file)
    }

    // reset file input
    if (fileRef.current) fileRef.current.value = ''
  }

  async function handleImportPreview() {
    if (importPhones.length === 0) return
    setImportLoading(true)
    setImportError(null)
    try {
      const res = await fetchJson<{ inserted: number; skipped: number; invalid: number }>(
        '/api/blacklist/import',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phones: importPhones, reason: importReason, preview: true }),
        },
      )
      setImportPreview(res)
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Error al previsualizar')
    } finally {
      setImportLoading(false)
    }
  }

  async function handleImportConfirm() {
    setImportLoading(true)
    setImportError(null)
    try {
      const res = await fetchJson<{ inserted: number; skipped: number; invalid: number }>(
        '/api/blacklist/import',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phones: importPhones, reason: importReason, preview: false }),
        },
      )
      setImportSuccess(
        `Importación completada: ${res.inserted} agregados, ${res.skipped} duplicados ignorados, ${res.invalid} inválidos.`,
      )
      setImportPhones([])
      setImportFileName('')
      setImportPreview(null)
      void fetchItems()
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Error al importar')
    } finally {
      setImportLoading(false)
    }
  }

  // ── Eliminar (soft-delete) ────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleteLoading(true)
    setDeleteError(null)
    try {
      await fetchJson(`/api/blacklist/${deleteTarget.id}`, { method: 'DELETE' })
      setDeleteTarget(null)
      void fetchItems()
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Error al quitar de blacklist')
    } finally {
      setDeleteLoading(false)
    }
  }

  // ── Exportar ─────────────────────────────────────────────────────────────────

  function handleExport() {
    const params = new URLSearchParams({
      status,
      ...(source !== 'all' ? { source } : {}),
    })
    window.open(`/api/blacklist/export?${params}`, '_blank')
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  const totalPages = Math.ceil(total / limit)

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-red-100 flex items-center justify-center">
            <ShieldOff size={18} className="text-red-600" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Blacklist Global</h1>
            <p className="text-sm text-gray-500">Números excluidos del envío de mensajes</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleExport} className="gap-2">
            <Download size={14} />
            Exportar CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowImport(true)} className="gap-2">
            <Upload size={14} />
            Importar
          </Button>
          <Button size="sm" onClick={() => { setShowAdd(true); setAddSuccess(null); setAddError(null) }} className="gap-2 bg-red-600 hover:bg-red-700 text-white">
            <Plus size={14} />
            Agregar número
          </Button>
        </div>
      </div>

      {/* Filtros */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 min-w-[200px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input
                placeholder="Buscar por número..."
                className="pl-8 h-8 text-sm"
                value={q}
                onChange={e => { setQ(e.target.value); setPage(1) }}
              />
            </div>
            <Select value={source} onValueChange={v => { setSource(v ?? 'all'); setPage(1) }}>
              <SelectTrigger className="h-8 text-sm w-40">
                <SelectValue placeholder="Origen" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los orígenes</SelectItem>
                <SelectItem value="manual">Manual</SelectItem>
                <SelectItem value="automatic">Automático</SelectItem>
                <SelectItem value="import">Importado</SelectItem>
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={v => { setStatus(v ?? 'active'); setPage(1) }}>
              <SelectTrigger className="h-8 text-sm w-40">
                <SelectValue placeholder="Estado" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Solo activos</SelectItem>
                <SelectItem value="removed">Solo removidos</SelectItem>
                <SelectItem value="all">Todos</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="ghost" size="sm" onClick={() => void fetchItems()} className="gap-1">
              <RefreshCw size={13} />
              Actualizar
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Tabla */}
      <Card>
        <CardContent className="p-0">
          {error && (
            <div className="p-4 text-sm text-red-600 flex items-center gap-2">
              <AlertTriangle size={14} /> {error}
            </div>
          )}

          {loading ? (
            <div className="p-8 text-center text-sm text-gray-500">Cargando...</div>
          ) : items.length === 0 ? (
            <div className="p-12 text-center">
              <ShieldOff size={32} className="mx-auto text-gray-300 mb-3" />
              <p className="text-sm font-medium text-gray-500">
                {status === 'active' ? 'No hay números en la blacklist actualmente' : 'No se encontraron registros'}
              </p>
              <p className="text-xs text-gray-400 mt-1">
                Los números agregados aquí quedan excluidos automáticamente de todas las campañas.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Número</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Motivo</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Origen</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Agregado por</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Fecha</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Estado</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map(item => (
                    <tr key={item.id} className={item.removed_at ? 'bg-gray-50 opacity-60' : 'hover:bg-gray-50'}>
                      <td className="px-4 py-3">
                        <div className="font-mono text-sm font-medium text-gray-900">
                          {formatPhone(item.phone_number_normalized)}
                        </div>
                        {item.phone_number_raw !== item.phone_number_normalized &&
                         !item.phone_number_raw.startsWith('+') && (
                          <div className="text-xs text-gray-400">{item.phone_number_raw}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-700 max-w-[200px]">
                        <span className="line-clamp-2">{item.reason ?? '—'}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${SOURCE_COLORS[item.source] ?? 'bg-gray-100 text-gray-700'}`}>
                          {SOURCE_LABELS[item.source] ?? item.source}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600 text-xs">{item.added_by_name ?? 'Sistema'}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{formatDate(item.added_at)}</td>
                      <td className="px-4 py-3">
                        {item.removed_at ? (
                          <Badge variant="outline" className="text-xs text-gray-500 border-gray-300">
                            Removido
                          </Badge>
                        ) : (
                          <Badge className="text-xs bg-red-100 text-red-700 border-0">
                            Activo
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {!item.removed_at && (
                          <button
                            onClick={() => { setDeleteTarget(item); setDeleteError(null) }}
                            className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-600 transition-colors"
                            title="Quitar de blacklist"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Paginación */}
          {totalPages > 1 && (
            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between">
              <span className="text-xs text-gray-500">
                {total} número(s) en total
              </span>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>
                  Anterior
                </Button>
                <span className="text-xs text-gray-500 px-2">{page} / {totalPages}</span>
                <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                  Siguiente
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Modal: Agregar número(s) ── */}
      <Dialog open={showAdd} onOpenChange={open => { setShowAdd(open); if (!open) { setAddSuccess(null); setAddError(null); setAddPhones(''); setAddReason('') } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldOff size={16} className="text-red-600" />
              Agregar a Blacklist
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 pt-1">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Número(s) de teléfono
              </label>
              <textarea
                className="w-full border border-gray-300 rounded-md text-sm px-3 py-2 h-28 resize-none focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500"
                placeholder={`Ingresá uno o varios números, uno por línea:\n+5491155551234\n+5491166667890`}
                value={addPhones}
                onChange={e => setAddPhones(e.target.value)}
              />
              <p className="text-xs text-gray-400 mt-1">
                Formatos aceptados: +549..., 549..., 011... El sistema normaliza automáticamente.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Motivo</label>
              <Select value={addReason} onValueChange={v => setAddReason(v ?? '')}>
                <SelectTrigger className="text-sm">
                  <SelectValue placeholder="Seleccioná un motivo..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Solicitud del cliente">Solicitud del cliente</SelectItem>
                  <SelectItem value="Solicitó baja vía mensaje">Solicitó baja vía mensaje</SelectItem>
                  <SelectItem value="Número inválido o rebote">Número inválido o rebote</SelectItem>
                  <SelectItem value="Queja o reclamo">Queja o reclamo</SelectItem>
                  <SelectItem value="Sin motivo especificado">Sin motivo especificado</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {addError && (
              <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                <AlertTriangle size={14} /> {addError}
              </div>
            )}

            {addSuccess && (
              <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">
                {addSuccess}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>
                Cancelar
              </Button>
              <Button
                size="sm"
                onClick={handleAdd}
                disabled={addLoading || !addPhones.trim()}
                className="bg-red-600 hover:bg-red-700 text-white"
              >
                {addLoading ? 'Agregando...' : 'Agregar a blacklist'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Modal: Importar ── */}
      <Dialog open={showImport} onOpenChange={open => { setShowImport(open); if (!open) { setImportPhones([]); setImportFileName(''); setImportPreview(null); setImportSuccess(null); setImportError(null) } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload size={16} className="text-purple-600" />
              Importar números a Blacklist
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 pt-1">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Archivo (CSV, Excel o TXT)
              </label>
              <p className="text-xs text-gray-500 mb-2">
                El archivo debe tener los números en la primera columna, un número por fila.
                Se aceptan formatos con o sin prefijo internacional.
              </p>
              <div
                className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:border-purple-400 transition-colors"
                onClick={() => fileRef.current?.click()}
              >
                {importFileName ? (
                  <div className="flex items-center justify-center gap-2 text-sm text-gray-700">
                    <Upload size={16} className="text-purple-500" />
                    <span>{importFileName}</span>
                    <span className="text-gray-400">({importPhones.length} filas leídas)</span>
                    <button
                      onClick={e => { e.stopPropagation(); setImportPhones([]); setImportFileName(''); setImportPreview(null) }}
                      className="text-gray-400 hover:text-gray-600"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <>
                    <Upload size={24} className="mx-auto text-gray-400 mb-2" />
                    <p className="text-sm text-gray-600">Hacer clic para seleccionar archivo</p>
                    <p className="text-xs text-gray-400 mt-1">.csv, .xlsx, .xls, .txt</p>
                  </>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.xlsx,.xls,.ods,.txt"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Motivo de la importación</label>
              <Input
                value={importReason}
                onChange={e => setImportReason(e.target.value)}
                placeholder="Ej: Limpieza mensual, lista de bajas..."
                className="text-sm"
              />
            </div>

            {importPhones.length > 0 && !importPreview && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleImportPreview}
                disabled={importLoading}
                className="w-full"
              >
                {importLoading ? 'Analizando...' : `Previsualizar (${importPhones.length} filas)`}
              </Button>
            )}

            {importPreview && (
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-2">
                <p className="text-sm font-medium text-gray-700">Resumen de importación</p>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="bg-green-50 rounded p-2">
                    <p className="text-lg font-bold text-green-700">{importPreview.inserted}</p>
                    <p className="text-xs text-green-600">Se agregarán</p>
                  </div>
                  <div className="bg-yellow-50 rounded p-2">
                    <p className="text-lg font-bold text-yellow-700">{importPreview.skipped}</p>
                    <p className="text-xs text-yellow-600">Ya existían</p>
                  </div>
                  <div className="bg-red-50 rounded p-2">
                    <p className="text-lg font-bold text-red-700">{importPreview.invalid}</p>
                    <p className="text-xs text-red-600">Inválidos</p>
                  </div>
                </div>
                {importPreview.inserted === 0 && (
                  <p className="text-xs text-gray-500 text-center">Todos los números ya estaban en blacklist o son inválidos.</p>
                )}
              </div>
            )}

            {importError && (
              <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                <AlertTriangle size={14} /> {importError}
              </div>
            )}

            {importSuccess && (
              <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">
                {importSuccess}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => setShowImport(false)}>
                Cancelar
              </Button>
              <Button
                size="sm"
                onClick={handleImportConfirm}
                disabled={importLoading || !importPreview || importPreview.inserted === 0}
                className="bg-purple-600 hover:bg-purple-700 text-white"
              >
                {importLoading ? 'Importando...' : `Confirmar importación`}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Modal: Confirmar eliminación ── */}
      <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open) { setDeleteTarget(null); setDeleteError(null) } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle size={16} className="text-amber-500" />
              Quitar de Blacklist
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 pt-1">
            <p className="text-sm text-gray-700">
              ¿Estás seguro de que querés quitar{' '}
              <span className="font-mono font-medium text-gray-900">
                {deleteTarget ? formatPhone(deleteTarget.phone_number_normalized) : ''}
              </span>{' '}
              de la blacklist?
            </p>
            <p className="text-xs text-gray-500">
              Al quitarlo, el número podrá volver a recibir mensajes de campañas.
            </p>

            {deleteError && (
              <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                <AlertTriangle size={14} /> {deleteError}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>
                Cancelar
              </Button>
              <Button
                size="sm"
                onClick={handleDelete}
                disabled={deleteLoading}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {deleteLoading ? 'Quitando...' : 'Sí, quitar de blacklist'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
