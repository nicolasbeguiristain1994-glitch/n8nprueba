'use client'

import { useEffect, useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AlertCircle, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'

// ── Tipos ─────────────────────────────────────────────────────────────────────

type AuditEntry = {
  id: string
  table_name: string
  record_id: string
  operation: 'INSERT' | 'UPDATE'
  old_value: Record<string, unknown> | null
  new_value: Record<string, unknown>
  changed_by: string
  changed_at: string
  workspace_id: string
  reason: string | null
}

type Pagination = {
  page: number
  limit: number
  total: number
  totalPages: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })
}

function tableLabel(name: string) {
  if (name === 'segmentation_tiers') return 'Segmentación'
  if (name === 'scoring_config')     return 'Scoring'
  return name
}

function operationBadge(op: 'INSERT' | 'UPDATE') {
  if (op === 'INSERT') return <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">NUEVO</span>
  return <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">EDIT</span>
}

function actorLabel(changedBy: string) {
  if (changedBy.startsWith('migration:')) return <span className="text-gray-400 italic">{changedBy}</span>
  if (changedBy === 'unknown')            return <span className="text-gray-400 italic">desconocido</span>
  // UUID-like → acortar
  if (changedBy.includes('-') && changedBy.length > 20) return changedBy.slice(0, 8) + '…'
  return changedBy
}

function computeDiff(
  oldVal: Record<string, unknown> | null,
  newVal: Record<string, unknown>,
): Array<{ field: string; old: unknown; new: unknown }> {
  if (!oldVal) return []
  const skipKeys = ['updated_at', 'updated_by', 'workspace_id']
  return Object.keys(newVal)
    .filter(k => !skipKeys.includes(k) && JSON.stringify(oldVal[k]) !== JSON.stringify(newVal[k]))
    .map(k => ({ field: k, old: oldVal[k], new: newVal[k] }))
}

function DiffCell({ entry }: { entry: AuditEntry }) {
  if (entry.operation === 'INSERT') {
    return <span className="text-xs text-gray-400 italic">Inserción inicial</span>
  }
  const diffs = computeDiff(entry.old_value, entry.new_value)
  if (!diffs.length) {
    return <span className="text-xs text-gray-400 italic">Sin diferencias detectadas</span>
  }
  return (
    <div className="space-y-0.5">
      {diffs.map(d => (
        <div key={d.field} className="flex items-center gap-1.5 text-xs">
          <span className="font-medium text-gray-600">{d.field}:</span>
          <span className="line-through text-gray-400">{String(d.old)}</span>
          <span className="text-gray-800 font-medium">→ {String(d.new)}</span>
        </div>
      ))}
    </div>
  )
}

// ── Componente principal ──────────────────────────────────────────────────────

export function AuditLogTab() {
  const [entries, setEntries]       = useState<AuditEntry[]>([])
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 20, total: 0, totalPages: 1 })
  const [loading, setLoading]       = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [tableFilter, setTableFilter] = useState<string>('__all__')

  const fetchEntries = useCallback(async (page: number, tableName: string) => {
    setLoading(true)
    setFetchError(null)
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' })
      if (tableName !== '__all__') params.set('table_name', tableName)

      const res = await fetch(`/api/settings/audit-log?${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { entries: AuditEntry[]; pagination: Pagination }
      setEntries(data.entries)
      setPagination(data.pagination)
    } catch {
      setFetchError('Error al cargar el historial de auditoría')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchEntries(1, tableFilter)
  }, [fetchEntries, tableFilter])

  function goToPage(p: number) {
    void fetchEntries(p, tableFilter)
  }

  function handleFilterChange(val: string | null) {
    setTableFilter(val ?? '__all__')
    // fetchEntries se dispara via useEffect
  }

  return (
    <div className="space-y-4">

      {/* Filtro */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-gray-700">Filtrar por tabla:</label>
        <Select value={tableFilter} onValueChange={handleFilterChange}>
          <SelectTrigger className="h-8 text-sm w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Todas</SelectItem>
            <SelectItem value="segmentation_tiers">Segmentación</SelectItem>
            <SelectItem value="scoring_config">Scoring</SelectItem>
          </SelectContent>
        </Select>
        {!loading && (
          <span className="text-xs text-gray-400">{pagination.total} registros</span>
        )}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Historial de Cambios</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center h-24">
              <Loader2 size={20} className="animate-spin text-gray-400" />
            </div>
          ) : fetchError ? (
            <div className="flex items-center gap-2 text-sm text-red-600">
              <AlertCircle size={16} /> {fetchError}
            </div>
          ) : entries.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">Sin registros de auditoría</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="text-left py-2 pr-3 font-medium text-gray-500 text-xs uppercase tracking-wide whitespace-nowrap">Fecha</th>
                    <th className="text-left py-2 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Tabla</th>
                    <th className="text-left py-2 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Registro</th>
                    <th className="text-left py-2 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Op.</th>
                    <th className="text-left py-2 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Cambios</th>
                    <th className="text-left py-2 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Actor</th>
                    <th className="text-left py-2 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide">Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(entry => (
                    <tr key={entry.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/40 align-top">
                      <td className="py-2.5 pr-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(entry.changed_at)}</td>
                      <td className="py-2.5 px-3 text-xs text-gray-600">{tableLabel(entry.table_name)}</td>
                      <td className="py-2.5 px-3 text-xs font-mono text-gray-500">{entry.record_id}</td>
                      <td className="py-2.5 px-3">{operationBadge(entry.operation)}</td>
                      <td className="py-2.5 px-3 max-w-xs">
                        <DiffCell entry={entry} />
                      </td>
                      <td className="py-2.5 px-3 text-xs text-gray-600 whitespace-nowrap">
                        {actorLabel(entry.changed_by)}
                      </td>
                      <td className="py-2.5 px-3 text-xs text-gray-500 max-w-xs">
                        {entry.reason ?? <span className="text-gray-300 italic">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Paginación */}
          {!loading && pagination.totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 border-t border-gray-100 mt-4">
              <span className="text-xs text-gray-500">
                Página {pagination.page} de {pagination.totalPages}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={() => goToPage(pagination.page - 1)}
                  disabled={pagination.page <= 1 || loading}
                >
                  <ChevronLeft size={14} />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={() => goToPage(pagination.page + 1)}
                  disabled={pagination.page >= pagination.totalPages || loading}
                >
                  <ChevronRight size={14} />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
