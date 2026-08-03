'use client'
import { useState, useCallback, useEffect } from 'react'
import * as XLSX from 'xlsx'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis,
  Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { Button }   from '@/components/ui/button'
import { Input }    from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/layout/PageHeader'
import { fetchJson }  from '@/lib/fetchJson'
import {
  Plus, CheckCircle2, Clock, Pencil, Trash2,
  Download, TrendingUp, TrendingDown, Loader2, X, Check,
} from 'lucide-react'

// ─── tipos ────────────────────────────────────────────────────────────────────

interface Report {
  id: string; oficina: string; linea: number; base_datos: string
  mensaje: string; segmentacion: string | null; enviados: number
  respuestas: number | null; cargas: number | null; fecha: string
  operador_nombre: string; observaciones: string | null
  estado: 'pendiente' | 'completo'
}

interface Stats {
  summary: {
    total_enviados: number; total_respuestas: number; total_cargas: number
    prev_enviados: number; prev_respuestas: number
  }
  by_day:     { fecha: string; enviados: number; respuestas: number; cargas: number }[]
  by_base:    { base_datos: string; enviados: number; respuestas: number }[]
  by_oficina: { oficina: string; enviados: number; respuestas: number; cargas: number }[]
  by_linea:   { linea: number; enviados: number; respuestas: number }[]
}

// ─── constantes ───────────────────────────────────────────────────────────────

const PANEL_OPTIONS = ['betcoin', 'bigwin', 'farabet', 'ofizeus', 'royal']
const TODAY = new Date().toISOString().slice(0, 10)

const EMPTY_FORM = {
  oficina: '', linea: '', base_datos: '', mensaje: '',
  segmentacion: '', enviados: '', observaciones: '', fecha: TODAY,
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function pct(num: number, den: number) {
  if (!den) return '—'
  return `${((num / den) * 100).toFixed(1)}%`
}

function delta(curr: number, prev: number) {
  if (!prev) return null
  const d = ((curr - prev) / prev) * 100
  return d
}

// ─── componente ───────────────────────────────────────────────────────────────

export default function ReportesPage() {
  const [tab, setTab] = useState<'registros' | 'dashboard'>('registros')

  // ── registros ──
  const [reports, setReports]     = useState<Report[]>([])
  const [total, setTotal]         = useState(0)
  const [loadingList, setLoadingList] = useState(false)
  const [listError, setListError] = useState('')

  // ── nuevo registro ──
  const [showForm, setShowForm] = useState(false)
  const [form, setForm]         = useState(EMPTY_FORM)
  const [saving, setSaving]     = useState(false)
  const [formError, setFormError] = useState('')

  // ── efectividad inline ──
  const [editId, setEditId]       = useState<string | null>(null)
  const [editResp, setEditResp]   = useState('')
  const [editCargas, setEditCargas] = useState('')
  const [editObs, setEditObs]     = useState('')
  const [savingEdit, setSavingEdit] = useState(false)

  // ── dashboard ──
  const [stats, setStats]       = useState<Stats | null>(null)
  const [period, setPeriod]     = useState<'week' | 'month'>('month')
  const [loadingStats, setLoadingStats] = useState(false)

  // ── cargar registros ──────────────────────────────────────────────────────
  const loadReports = useCallback(async () => {
    setLoadingList(true); setListError('')
    try {
      const data = await fetchJson<{ reports: Report[]; total: number }>('/api/reports')
      setReports(data.reports); setTotal(data.total)
    } catch (e) {
      setListError(e instanceof Error ? e.message : 'Error al cargar')
    } finally { setLoadingList(false) }
  }, [])

  // ── cargar stats ──────────────────────────────────────────────────────────
  const loadStats = useCallback(async (p: 'week' | 'month') => {
    setLoadingStats(true)
    try {
      const data = await fetchJson<Stats>(`/api/reports/stats?period=${p}`)
      setStats(data)
    } catch { /* silencioso */ } finally { setLoadingStats(false) }
  }, [])

  useEffect(() => { loadReports() }, [loadReports])
  useEffect(() => {
    if (tab === 'dashboard') loadStats(period)
  }, [tab, period, loadStats])

  // ── crear registro ────────────────────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    if (!form.oficina || !form.linea || !form.base_datos || !form.mensaje || !form.enviados) {
      setFormError('Completá los campos obligatorios.'); return
    }
    setSaving(true); setFormError('')
    try {
      await fetchJson('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, linea: Number(form.linea), enviados: Number(form.enviados) }),
      })
      setShowForm(false); setForm(EMPTY_FORM); loadReports()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Error al guardar')
    } finally { setSaving(false) }
  }, [form, loadReports])

  // ── guardar efectividad ───────────────────────────────────────────────────
  const handleSaveEdit = useCallback(async () => {
    if (!editId) return
    setSavingEdit(true)
    try {
      const body: Record<string, unknown> = {}
      if (editResp   !== '') body.respuestas    = Number(editResp)
      if (editCargas !== '') body.cargas        = Number(editCargas)
      if (editObs    !== '') body.observaciones = editObs
      const data = await fetchJson<{ report: Report }>(`/api/reports/${editId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setReports(prev => prev.map(r => r.id === editId ? data.report : r))
      setEditId(null)
    } catch { /* silencioso */ } finally { setSavingEdit(false) }
  }, [editId, editResp, editCargas, editObs])

  const startEdit = (r: Report) => {
    setEditId(r.id)
    setEditResp(r.respuestas != null ? String(r.respuestas) : '')
    setEditCargas(r.cargas != null ? String(r.cargas) : '')
    setEditObs(r.observaciones ?? '')
  }

  // ── borrar ────────────────────────────────────────────────────────────────
  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('¿Eliminar este registro?')) return
    await fetchJson(`/api/reports/${id}`, { method: 'DELETE' })
    setReports(prev => prev.filter(r => r.id !== id))
  }, [])

  // ── export Excel ─────────────────────────────────────────────────────────
  const exportExcel = useCallback(async () => {
    const data = await fetchJson<{ reports: Report[] }>('/api/reports?export=1')
    const rows = data.reports.map(r => ({
      Fecha:        r.fecha,
      Operador:     r.operador_nombre,
      Oficina:      r.oficina,
      Línea:        r.linea,
      'Base datos': r.base_datos,
      Segmentación: r.segmentacion ?? '',
      Enviados:     r.enviados,
      Respuestas:   r.respuestas ?? '',
      Cargas:       r.cargas ?? '',
      'Tasa resp %': r.respuestas != null && r.enviados ? ((r.respuestas / r.enviados) * 100).toFixed(1) : '',
      'Tasa carga %': r.cargas != null && r.enviados ? ((r.cargas / r.enviados) * 100).toFixed(1) : '',
      Estado:       r.estado,
      Observaciones: r.observaciones ?? '',
      Mensaje:      r.mensaje,
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Reportes')
    XLSX.writeFile(wb, `reportes_${TODAY}.xlsx`)
  }, [])

  // ─── render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      <PageHeader title="Reportes" description="Seguimiento diario de envíos y efectividad por operador." />

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {(['registros', 'dashboard'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize border-b-2 transition-colors ${
              tab === t
                ? 'border-violet-500 text-violet-600'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t === 'registros' ? 'Mis Registros' : 'Dashboard'}
          </button>
        ))}
      </div>

      {/* ══════════════════ TAB: REGISTROS ══════════════════ */}
      {tab === 'registros' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{total} registro{total !== 1 ? 's' : ''}</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={exportExcel}>
                <Download size={14} className="mr-1.5" /> Exportar Excel
              </Button>
              <Button size="sm" onClick={() => { setShowForm(v => !v); setFormError('') }}>
                <Plus size={14} className="mr-1.5" /> Nuevo registro
              </Button>
            </div>
          </div>

          {/* Formulario nuevo registro */}
          {showForm && (
            <div className="border rounded-lg p-4 space-y-3 bg-muted/20">
              <p className="text-sm font-medium">Registro de fin de jornada</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Oficina *</label>
                  <Select value={form.oficina} onValueChange={v => setForm(f => ({ ...f, oficina: v ?? '' }))}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Oficina" /></SelectTrigger>
                    <SelectContent>
                      {PANEL_OPTIONS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Línea *</label>
                  <Input type="number" min={1} value={form.linea} onChange={e => setForm(f => ({ ...f, linea: e.target.value }))} className="h-8 text-sm" placeholder="1" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Enviados *</label>
                  <Input type="number" min={0} value={form.enviados} onChange={e => setForm(f => ({ ...f, enviados: e.target.value }))} className="h-8 text-sm" placeholder="0" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Fecha *</label>
                  <Input type="date" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} className="h-8 text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Base de datos *</label>
                  <Input value={form.base_datos} onChange={e => setForm(f => ({ ...f, base_datos: e.target.value }))} className="h-8 text-sm" placeholder="Ej: VIP Bigwin +45 días" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Segmentación</label>
                  <Input value={form.segmentacion} onChange={e => setForm(f => ({ ...f, segmentacion: e.target.value }))} className="h-8 text-sm" placeholder="Opcional" />
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Mensaje enviado *</label>
                <Textarea value={form.mensaje} onChange={e => setForm(f => ({ ...f, mensaje: e.target.value }))} rows={2} className="text-sm resize-none" placeholder="Pegá el texto del mensaje" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Observaciones</label>
                <Input value={form.observaciones} onChange={e => setForm(f => ({ ...f, observaciones: e.target.value }))} className="h-8 text-sm" placeholder="Opcional" />
              </div>
              {formError && <p className="text-xs text-red-600">{formError}</p>}
              <div className="flex gap-2">
                <Button size="sm" onClick={handleCreate} disabled={saving}>
                  {saving ? <Loader2 size={13} className="mr-1 animate-spin" /> : <Check size={13} className="mr-1" />}
                  Guardar
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setShowForm(false); setForm(EMPTY_FORM) }}>
                  <X size={13} className="mr-1" /> Cancelar
                </Button>
              </div>
            </div>
          )}

          {listError && <p className="text-sm text-red-600">{listError}</p>}
          {loadingList && <p className="text-sm text-muted-foreground">Cargando...</p>}

          {/* Tabla */}
          {!loadingList && reports.length > 0 && (
            <div className="border rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Fecha</th>
                      <th className="text-left px-3 py-2 font-medium">Oficina / Línea</th>
                      <th className="text-left px-3 py-2 font-medium">Base de datos</th>
                      <th className="text-right px-3 py-2 font-medium">Enviados</th>
                      <th className="text-right px-3 py-2 font-medium">Resp.</th>
                      <th className="text-right px-3 py-2 font-medium">Cargas</th>
                      <th className="text-right px-3 py-2 font-medium">Tasa R.</th>
                      <th className="text-left px-3 py-2 font-medium">Estado</th>
                      <th className="text-left px-3 py-2 font-medium">Operador</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {reports.map(r => (
                      <>
                        <tr key={r.id} className="border-t">
                          <td className="px-3 py-2 whitespace-nowrap">{r.fecha}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{r.oficina} / {r.linea}</td>
                          <td className="px-3 py-2 max-w-[140px] truncate">{r.base_datos}</td>
                          <td className="px-3 py-2 text-right">{r.enviados.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right">{r.respuestas ?? '—'}</td>
                          <td className="px-3 py-2 text-right">{r.cargas ?? '—'}</td>
                          <td className="px-3 py-2 text-right">{pct(r.respuestas ?? 0, r.enviados)}</td>
                          <td className="px-3 py-2">
                            {r.estado === 'completo'
                              ? <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 rounded-full px-2 py-0.5"><CheckCircle2 size={11} /> Completo</span>
                              : <span className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-100 rounded-full px-2 py-0.5"><Clock size={11} /> Pendiente</span>
                            }
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap text-muted-foreground text-xs">{r.operador_nombre}</td>
                          <td className="px-3 py-2 text-right whitespace-nowrap">
                            {r.estado === 'pendiente' && editId !== r.id && (
                              <Button size="sm" variant="outline" className="h-7 text-xs mr-1" onClick={() => startEdit(r)}>
                                <Pencil size={11} className="mr-1" /> Efectividad
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-400 hover:text-red-600" onClick={() => handleDelete(r.id)}>
                              <Trash2 size={12} />
                            </Button>
                          </td>
                        </tr>

                        {/* Fila inline de efectividad */}
                        {editId === r.id && (
                          <tr key={`edit-${r.id}`} className="border-t bg-amber-50/40">
                            <td colSpan={10} className="px-3 py-3">
                              <div className="flex items-end gap-3 flex-wrap">
                                <div>
                                  <label className="text-xs text-muted-foreground block mb-1">Respuestas</label>
                                  <Input type="number" min={0} value={editResp} onChange={e => setEditResp(e.target.value)} className="h-8 w-28 text-sm" />
                                </div>
                                <div>
                                  <label className="text-xs text-muted-foreground block mb-1">Cargas</label>
                                  <Input type="number" min={0} value={editCargas} onChange={e => setEditCargas(e.target.value)} className="h-8 w-28 text-sm" />
                                </div>
                                <div className="flex-1 min-w-[160px]">
                                  <label className="text-xs text-muted-foreground block mb-1">Observaciones</label>
                                  <Input value={editObs} onChange={e => setEditObs(e.target.value)} className="h-8 text-sm" placeholder="Opcional" />
                                </div>
                                <div className="flex gap-2">
                                  <Button size="sm" onClick={handleSaveEdit} disabled={savingEdit} className="h-8">
                                    {savingEdit ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} className="mr-1" />}
                                    Guardar
                                  </Button>
                                  <Button size="sm" variant="ghost" className="h-8" onClick={() => setEditId(null)}>
                                    <X size={13} />
                                  </Button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!loadingList && reports.length === 0 && !listError && (
            <p className="text-sm text-muted-foreground text-center py-8">
              No hay registros todavía. Creá el primero al finalizar la jornada.
            </p>
          )}
        </div>
      )}

      {/* ══════════════════ TAB: DASHBOARD ══════════════════ */}
      {tab === 'dashboard' && (
        <div className="space-y-6">
          {/* Selector de período */}
          <div className="flex items-center gap-2">
            {(['week', 'month'] as const).map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`text-sm px-3 py-1.5 rounded-full border transition-colors ${
                  period === p
                    ? 'bg-violet-600 text-white border-violet-600'
                    : 'border-zinc-300 text-zinc-600 hover:border-violet-400'
                }`}
              >
                {p === 'week' ? 'Esta semana' : 'Este mes'}
              </button>
            ))}
            {loadingStats && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
          </div>

          {stats && (
            <>
              {/* Stat cards */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {[
                  {
                    label: 'Mensajes enviados',
                    value: stats.summary.total_enviados.toLocaleString(),
                    d: delta(stats.summary.total_enviados, stats.summary.prev_enviados),
                  },
                  {
                    label: 'Respuestas',
                    value: stats.summary.total_respuestas.toLocaleString(),
                    d: delta(stats.summary.total_respuestas, stats.summary.prev_respuestas),
                  },
                  { label: 'Cargas', value: stats.summary.total_cargas.toLocaleString(), d: null },
                  {
                    label: 'Tasa respuesta',
                    value: pct(stats.summary.total_respuestas, stats.summary.total_enviados),
                    d: null,
                  },
                  {
                    label: 'Tasa carga',
                    value: pct(stats.summary.total_cargas, stats.summary.total_enviados),
                    d: null,
                  },
                ].map(card => (
                  <div key={card.label} className="border rounded-lg p-3 space-y-1">
                    <p className="text-xs text-muted-foreground">{card.label}</p>
                    <p className="text-2xl font-semibold">{card.value}</p>
                    {card.d != null && (
                      <p className={`text-xs flex items-center gap-0.5 ${card.d >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                        {card.d >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                        {card.d >= 0 ? '+' : ''}{card.d.toFixed(1)}% vs período anterior
                      </p>
                    )}
                  </div>
                ))}
              </div>

              {/* Enviados por día */}
              {stats.by_day.length > 0 && (
                <div className="border rounded-lg p-4 space-y-2">
                  <p className="text-sm font-medium">Enviados por día</p>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={stats.by_day}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="fecha" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Legend />
                      <Line type="monotone" dataKey="enviados" stroke="#7c3aed" strokeWidth={2} dot={false} name="Enviados" />
                      <Line type="monotone" dataKey="respuestas" stroke="#10b981" strokeWidth={2} dot={false} name="Respuestas" />
                      <Line type="monotone" dataKey="cargas" stroke="#f59e0b" strokeWidth={2} dot={false} name="Cargas" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Por oficina + por base */}
              <div className="grid md:grid-cols-2 gap-4">
                {stats.by_oficina.length > 0 && (
                  <div className="border rounded-lg p-4 space-y-2">
                    <p className="text-sm font-medium">Por oficina</p>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={stats.by_oficina}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                        <XAxis dataKey="oficina" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip />
                        <Legend />
                        <Bar dataKey="enviados"   fill="#7c3aed" name="Enviados"   />
                        <Bar dataKey="respuestas" fill="#10b981" name="Respuestas" />
                        <Bar dataKey="cargas"     fill="#f59e0b" name="Cargas"     />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {stats.by_base.length > 0 && (
                  <div className="border rounded-lg p-4 space-y-2">
                    <p className="text-sm font-medium">Por base de datos</p>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={stats.by_base} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                        <XAxis type="number" tick={{ fontSize: 11 }} />
                        <YAxis dataKey="base_datos" type="category" tick={{ fontSize: 10 }} width={100} />
                        <Tooltip />
                        <Bar dataKey="enviados"   fill="#7c3aed" name="Enviados"   />
                        <Bar dataKey="respuestas" fill="#10b981" name="Respuestas" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>

              {/* Por línea */}
              {stats.by_linea.length > 0 && (
                <div className="border rounded-lg p-4 space-y-2">
                  <p className="text-sm font-medium">Por línea</p>
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={stats.by_linea}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="linea" tick={{ fontSize: 11 }} label={{ value: 'Línea', position: 'insideBottom', offset: -2, fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="enviados"   fill="#7c3aed" name="Enviados"   />
                      <Bar dataKey="respuestas" fill="#10b981" name="Respuestas" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {stats.by_day.length === 0 && stats.by_oficina.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No hay datos para este período todavía.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
