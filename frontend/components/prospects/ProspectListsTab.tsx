'use client'
import { useEffect, useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  RefreshCw, Trash2, Search, Plus, ChevronLeft,
  Users, Megaphone, Calendar, CheckSquare, X,
} from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'
import type { ProspectList, ProspectListMember, Prospect } from '@/lib/prospects'

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

function formatDateTime(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// ── Tipos locales ─────────────────────────────────────────────────────────────

interface ListDetailResponse {
  list:    ProspectList
  members: ProspectListMember[]
  total:   number
  page:    number
  limit:   number
}

// ── Componente principal ──────────────────────────────────────────────────────

export function ProspectListsTab() {
  // ── Vista activa ──────────────────────────────────────────────────────────
  const [view, setView] = useState<'list' | 'detail'>('list')

  // ── Vista de lista ────────────────────────────────────────────────────────
  const [lists, setLists]         = useState<ProspectList[]>([])
  const [total, setTotal]         = useState(0)
  const [loading, setLoading]     = useState(false)
  const [search, setSearch]       = useState('')
  const [page, setPage]           = useState(1)
  const LIMIT = 50

  // ── Vista de detalle ──────────────────────────────────────────────────────
  const [selectedList, setSelectedList]   = useState<ProspectList | null>(null)
  const [members, setMembers]             = useState<ProspectListMember[]>([])
  const [membersTotal, setMembersTotal]   = useState(0)
  const [memberSearch, setMemberSearch]   = useState('')
  const [memberPage, setMemberPage]       = useState(1)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [deletingMemberId, setDeletingMemberId] = useState<string | null>(null)

  // ── Modal nueva lista ─────────────────────────────────────────────────────
  const [showCreate, setShowCreate]       = useState(false)
  const [createName, setCreateName]       = useState('')
  const [createDesc, setCreateDesc]       = useState('')
  const [creating, setCreating]           = useState(false)
  const [createError, setCreateError]     = useState<string | null>(null)

  // ── Modal "Crear desde selección de prospectos" ───────────────────────────
  const [showFromSelection, setShowFromSelection]   = useState(false)
  const [selectionName, setSelectionName]           = useState('')
  const [selectionDesc, setSelectionDesc]           = useState('')
  const [prospectSearch, setProspectSearch]         = useState('')
  const [prospectPage, setProspectPage]             = useState(1)
  const [prospects, setProspects]                   = useState<Prospect[]>([])
  const [prospectsTotal, setProspectsTotal]         = useState(0)
  const [loadingProspects, setLoadingProspects]     = useState(false)
  const [selectedProspects, setSelectedProspects]   = useState<Set<string>>(new Set())
  const [savingSelection, setSavingSelection]       = useState(false)
  const [selectionError, setSelectionError]         = useState<string | null>(null)

  // ── Modal agregar prospectos a lista existente ────────────────────────────
  const [showAddToList, setShowAddToList]     = useState(false)
  const [addSearch, setAddSearch]             = useState('')
  const [addPage, setAddPage]                 = useState(1)
  const [addProspects, setAddProspects]       = useState<Prospect[]>([])
  const [addProspectsTotal, setAddProspectsTotal] = useState(0)
  const [loadingAdd, setLoadingAdd]           = useState(false)
  const [selectedAdd, setSelectedAdd]         = useState<Set<string>>(new Set())
  const [adding, setAdding]                   = useState(false)
  const [addError, setAddError]               = useState<string | null>(null)

  // ── Carga principal ────────────────────────────────────────────────────────
  const loadLists = useCallback(async () => {
    setLoading(true)
    try {
      const q = new URLSearchParams({ q: search, page: String(page), limit: String(LIMIT) })
      const data = await fetchJson<{ lists: ProspectList[]; total: number }>(`/api/prospect-lists?${q}`)
      setLists(data.lists || [])
      setTotal(data.total || 0)
    } catch {
      setLists([])
    } finally {
      setLoading(false)
    }
  }, [search, page])

  useEffect(() => { loadLists() }, [loadLists])

  // ── Detalle de lista ───────────────────────────────────────────────────────
  const loadDetail = useCallback(async (listId: string) => {
    setLoadingDetail(true)
    try {
      const q = new URLSearchParams({ q: memberSearch, page: String(memberPage), limit: '50' })
      const data = await fetchJson<ListDetailResponse>(`/api/prospect-lists/${listId}?${q}`)
      setSelectedList(data.list)
      setMembers(data.members || [])
      setMembersTotal(data.total || 0)
    } catch {
      setMembers([])
    } finally {
      setLoadingDetail(false)
    }
  }, [memberSearch, memberPage])

  const openDetail = (list: ProspectList) => {
    setSelectedList(list)
    setMemberSearch('')
    setMemberPage(1)
    setView('detail')
  }

  useEffect(() => {
    if (view === 'detail' && selectedList) {
      loadDetail(selectedList.id)
    }
  }, [view, selectedList?.id, memberSearch, memberPage, loadDetail])

  // ── Eliminar lista ─────────────────────────────────────────────────────────
  const deleteList = async (id: string, name: string) => {
    if (!confirm(`¿Eliminar la lista "${name}"? Esta acción no se puede deshacer.`)) return
    try {
      const res = await fetch(`/api/prospect-lists/${id}`, { method: 'DELETE' })
      if (res.ok) loadLists()
    } catch { /* silencioso */ }
  }

  // ── Eliminar miembro ───────────────────────────────────────────────────────
  const deleteMember = async (memberId: string) => {
    if (!selectedList) return
    setDeletingMemberId(memberId)
    try {
      await fetch(`/api/prospect-lists/${selectedList.id}/members/${memberId}`, { method: 'DELETE' })
      loadDetail(selectedList.id)
    } finally {
      setDeletingMemberId(null)
    }
  }

  // ── Crear lista nueva ──────────────────────────────────────────────────────
  const submitCreate = async () => {
    if (!createName.trim()) { setCreateError('El nombre es requerido'); return }
    setCreating(true); setCreateError(null)
    try {
      const res = await fetch('/api/prospect-lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: createName.trim(), description: createDesc.trim() || null }),
      })
      const d = await res.json()
      if (!res.ok) { setCreateError(d.error || 'Error al crear la lista'); return }
      setShowCreate(false)
      setCreateName(''); setCreateDesc('')
      loadLists()
    } catch { setCreateError('Error de red') }
    finally { setCreating(false) }
  }

  // ── Cargar prospectos (modal de selección) ─────────────────────────────────
  const loadProspects = useCallback(async (
    searchVal: string, pageVal: number,
    setData: (p: Prospect[]) => void,
    setTotalData: (n: number) => void,
    setLoadingData: (b: boolean) => void,
  ) => {
    setLoadingData(true)
    try {
      const q = new URLSearchParams({ q: searchVal, page: String(pageVal), limit: '50', status: 'active' })
      const data = await fetchJson<{ prospects: Prospect[]; total: number }>(`/api/prospects?${q}`)
      setData(data.prospects || [])
      setTotalData(data.total || 0)
    } finally {
      setLoadingData(false)
    }
  }, [])

  useEffect(() => {
    if (showFromSelection) {
      loadProspects(prospectSearch, prospectPage, setProspects, setProspectsTotal, setLoadingProspects)
    }
  }, [showFromSelection, prospectSearch, prospectPage, loadProspects])

  useEffect(() => {
    if (showAddToList) {
      loadProspects(addSearch, addPage, setAddProspects, setAddProspectsTotal, setLoadingAdd)
    }
  }, [showAddToList, addSearch, addPage, loadProspects])

  // ── Crear lista desde selección ────────────────────────────────────────────
  const submitFromSelection = async () => {
    if (!selectionName.trim()) { setSelectionError('El nombre es requerido'); return }
    if (selectedProspects.size === 0) { setSelectionError('Seleccioná al menos un prospecto'); return }
    setSavingSelection(true); setSelectionError(null)
    try {
      const res = await fetch('/api/prospect-lists/from-selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:         selectionName.trim(),
          description:  selectionDesc.trim() || null,
          prospect_ids: Array.from(selectedProspects),
        }),
      })
      const d = await res.json()
      if (!res.ok) { setSelectionError(d.error || 'Error al crear la lista'); return }
      setShowFromSelection(false)
      setSelectionName(''); setSelectionDesc(''); setSelectedProspects(new Set())
      loadLists()
    } catch { setSelectionError('Error de red') }
    finally { setSavingSelection(false) }
  }

  // ── Agregar prospectos a lista existente ───────────────────────────────────
  const submitAddToList = async () => {
    if (!selectedList) return
    if (selectedAdd.size === 0) { setAddError('Seleccioná al menos un prospecto'); return }
    setAdding(true); setAddError(null)
    try {
      const res = await fetch(`/api/prospect-lists/${selectedList.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prospect_ids: Array.from(selectedAdd) }),
      })
      const d = await res.json()
      if (!res.ok) { setAddError(d.error || 'Error al agregar'); return }
      setShowAddToList(false); setSelectedAdd(new Set()); setAddSearch(''); setAddPage(1)
      loadDetail(selectedList.id)
    } catch { setAddError('Error de red') }
    finally { setAdding(false) }
  }

  const toggleProspect = (id: string, set: Set<string>, setter: (s: Set<string>) => void) => {
    const next = new Set(set)
    next.has(id) ? next.delete(id) : next.add(id)
    setter(next)
  }

  const selectAll = (items: Prospect[], set: Set<string>, setter: (s: Set<string>) => void) => {
    const next = new Set(set)
    items.forEach(p => next.add(p.id))
    setter(next)
  }

  const deselectAll = (setter: (s: Set<string>) => void) => setter(new Set())

  // ── RENDER ─────────────────────────────────────────────────────────────────

  if (view === 'detail' && selectedList) {
    return (
      <DetailView
        list={selectedList}
        members={members}
        membersTotal={membersTotal}
        memberPage={memberPage}
        setMemberPage={setMemberPage}
        memberSearch={memberSearch}
        setMemberSearch={v => { setMemberSearch(v); setMemberPage(1) }}
        loading={loadingDetail}
        deletingMemberId={deletingMemberId}
        onDelete={deleteMember}
        onBack={() => { setView('list'); setSelectedList(null) }}
        onRefresh={() => loadDetail(selectedList.id)}
        onAddProspects={() => {
          setSelectedAdd(new Set())
          setAddSearch(''); setAddPage(1); setAddError(null)
          setShowAddToList(true)
        }}
        // Modal agregar
        showAddToList={showAddToList}
        setShowAddToList={setShowAddToList}
        addSearch={addSearch}
        setAddSearch={v => { setAddSearch(v); setAddPage(1) }}
        addPage={addPage}
        setAddPage={setAddPage}
        addProspects={addProspects}
        addProspectsTotal={addProspectsTotal}
        loadingAdd={loadingAdd}
        selectedAdd={selectedAdd}
        onToggleAdd={id => toggleProspect(id, selectedAdd, setSelectedAdd)}
        onSelectAllAdd={() => selectAll(addProspects, selectedAdd, setSelectedAdd)}
        onDeselectAllAdd={() => deselectAll(setSelectedAdd)}
        adding={adding}
        addError={addError}
        onSubmitAdd={submitAddToList}
      />
    )
  }

  // ── Vista lista ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-gray-800">Listas de Difusión</h2>
          <Badge variant="secondary">{total}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadLists} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </Button>
          <Button
            size="sm" variant="outline"
            className="border-teal-200 text-teal-700 hover:bg-teal-50"
            onClick={() => {
              setSelectedProspects(new Set()); setProspectSearch(''); setProspectPage(1)
              setSelectionName(''); setSelectionDesc(''); setSelectionError(null)
              setShowFromSelection(true)
            }}
          >
            <Users size={14} className="mr-1" /> Crear desde selección
          </Button>
          <Button
            size="sm"
            onClick={() => { setCreateName(''); setCreateDesc(''); setCreateError(null); setShowCreate(true) }}
          >
            <Plus size={14} className="mr-1" /> Nueva lista
          </Button>
        </div>
      </div>

      {/* Búsqueda */}
      <div className="relative max-w-xs">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
        <Input
          placeholder="Buscar lista..."
          className="pl-8 h-8 text-sm"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1) }}
        />
      </div>

      {/* Tabla de listas */}
      {loading ? (
        <div className="text-sm text-gray-400 py-8 text-center">Cargando…</div>
      ) : lists.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 py-14 flex flex-col items-center gap-3 text-gray-400">
          <Users size={32} className="opacity-30" />
          <p className="text-sm">No hay listas de difusión todavía.</p>
          <Button size="sm" variant="outline" onClick={() => setShowCreate(true)}>
            <Plus size={13} className="mr-1" /> Crear primera lista
          </Button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-2.5 font-medium">Nombre</th>
                <th className="px-4 py-2.5 font-medium text-right">Prospectos</th>
                <th className="px-4 py-2.5 font-medium text-right">Campañas</th>
                <th className="px-4 py-2.5 font-medium">Último uso</th>
                <th className="px-4 py-2.5 font-medium">Creada</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {lists.map((l, i) => (
                <tr
                  key={l.id}
                  className={`border-b border-gray-50 cursor-pointer hover:bg-blue-50/40 transition-colors ${i % 2 === 0 ? '' : 'bg-gray-50/30'}`}
                  onClick={() => openDetail(l)}
                >
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-800">{l.name}</p>
                    {l.description && (
                      <p className="text-[11px] text-gray-400 mt-0.5 truncate max-w-[260px]">{l.description}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="inline-flex items-center gap-1 text-gray-700">
                      <Users size={12} className="text-gray-400" />
                      {l.member_count.toLocaleString()}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="inline-flex items-center gap-1 text-gray-700">
                      <Megaphone size={12} className="text-gray-400" />
                      {l.campaign_count}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-[12px]">
                    {l.last_used_at ? formatDate(l.last_used_at) : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-[12px]">{formatDate(l.created_at)}</td>
                  <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                    <button
                      className="p-1 text-gray-300 hover:text-red-500 transition-colors rounded"
                      title="Eliminar lista"
                      onClick={() => deleteList(l.id, l.name)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Paginación */}
      {total > LIMIT && (
        <div className="flex items-center justify-end gap-2 text-sm text-gray-500">
          <button disabled={page === 1} onClick={() => setPage(p => p - 1)}
            className="px-3 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40">←</button>
          <span>Página {page} de {Math.ceil(total / LIMIT)}</span>
          <button disabled={page * LIMIT >= total} onClick={() => setPage(p => p + 1)}
            className="px-3 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40">→</button>
        </div>
      )}

      {/* Modal nueva lista */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Nueva lista de difusión</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Nombre *</label>
              <Input
                placeholder="Ej: Prospectos Mayo 2025"
                value={createName}
                onChange={e => setCreateName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && submitCreate()}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Descripción (opcional)</label>
              <Input
                placeholder="Ej: Importados de base externa CSV"
                value={createDesc}
                onChange={e => setCreateDesc(e.target.value)}
              />
            </div>
            {createError && <p className="text-xs text-red-500">{createError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancelar</Button>
            <Button onClick={submitCreate} disabled={creating}>
              {creating ? 'Creando…' : 'Crear lista'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal crear desde selección */}
      <Dialog open={showFromSelection} onOpenChange={v => { if (!v) setShowFromSelection(false) }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Crear lista desde selección de prospectos</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 overflow-hidden flex-1 min-h-0">
            {/* Nombre + descripción */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Nombre de la lista *</label>
                <Input
                  placeholder="Ej: Prospectos Mayo 2025"
                  value={selectionName}
                  onChange={e => setSelectionName(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Descripción (opcional)</label>
                <Input
                  placeholder="Ej: CSV externo junio"
                  value={selectionDesc}
                  onChange={e => setSelectionDesc(e.target.value)}
                />
              </div>
            </div>

            {/* Buscador + selección */}
            <div className="flex items-center justify-between gap-2">
              <div className="relative flex-1">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <Input
                  placeholder="Buscar prospectos..."
                  className="pl-8 h-8 text-sm"
                  value={prospectSearch}
                  onChange={e => { setProspectSearch(e.target.value); setProspectPage(1) }}
                />
              </div>
              <div className="flex items-center gap-1.5 text-xs text-gray-500 shrink-0">
                <button
                  className="text-blue-600 hover:underline"
                  onClick={() => selectAll(prospects, selectedProspects, setSelectedProspects)}
                >
                  <CheckSquare size={12} className="inline mr-0.5" /> Seleccionar página
                </button>
                {selectedProspects.size > 0 && (
                  <button className="text-gray-400 hover:text-red-500" onClick={() => deselectAll(setSelectedProspects)}>
                    <X size={12} className="inline mr-0.5" /> Limpiar ({selectedProspects.size})
                  </button>
                )}
              </div>
            </div>

            {/* Tabla prospectos */}
            <div className="overflow-y-auto flex-1 rounded-lg border border-gray-200 min-h-0">
              {loadingProspects ? (
                <div className="text-sm text-gray-400 py-8 text-center">Cargando…</div>
              ) : prospects.length === 0 ? (
                <div className="text-sm text-gray-400 py-8 text-center">Sin resultados</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50 border-b border-gray-100 text-xs text-gray-500">
                    <tr>
                      <th className="w-8 px-3 py-2" />
                      <th className="px-3 py-2 text-left font-medium">Teléfono</th>
                      <th className="px-3 py-2 text-left font-medium">Nombre</th>
                      <th className="px-3 py-2 text-left font-medium">Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prospects.map(p => {
                      const checked = selectedProspects.has(p.id)
                      return (
                        <tr
                          key={p.id}
                          className={`border-b border-gray-50 cursor-pointer hover:bg-blue-50/30 transition-colors ${checked ? 'bg-blue-50' : ''}`}
                          onClick={() => toggleProspect(p.id, selectedProspects, setSelectedProspects)}
                        >
                          <td className="px-3 py-2 text-center">
                            <input type="checkbox" readOnly checked={checked} className="accent-blue-600 cursor-pointer" />
                          </td>
                          <td className="px-3 py-2 font-mono text-[12px] text-gray-700">{p.phone_number}</td>
                          <td className="px-3 py-2 text-gray-700">
                            {[p.first_name, p.last_name].filter(Boolean).join(' ') || <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-3 py-2">
                            <Badge variant={p.opt_in ? 'default' : 'secondary'} className="text-[10px]">
                              {p.status === 'active' ? 'activo' : 'baja'}
                            </Badge>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Paginación prospectos */}
            {prospectsTotal > 50 && (
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>{prospectsTotal.toLocaleString()} prospectos totales</span>
                <div className="flex items-center gap-2">
                  <button disabled={prospectPage === 1} onClick={() => setProspectPage(p => p - 1)}
                    className="px-2 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40">←</button>
                  <span>Pág. {prospectPage}</span>
                  <button disabled={prospectPage * 50 >= prospectsTotal} onClick={() => setProspectPage(p => p + 1)}
                    className="px-2 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40">→</button>
                </div>
              </div>
            )}

            {selectionError && <p className="text-xs text-red-500">{selectionError}</p>}
          </div>
          <DialogFooter className="pt-2">
            <span className="text-xs text-gray-400 mr-auto">{selectedProspects.size} seleccionado{selectedProspects.size !== 1 ? 's' : ''}</span>
            <Button variant="outline" onClick={() => setShowFromSelection(false)}>Cancelar</Button>
            <Button onClick={submitFromSelection} disabled={savingSelection || selectedProspects.size === 0}>
              {savingSelection ? 'Creando…' : 'Crear lista'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Vista Detalle ─────────────────────────────────────────────────────────────

interface DetailViewProps {
  list:           ProspectList
  members:        ProspectListMember[]
  membersTotal:   number
  memberPage:     number
  setMemberPage:  (n: number) => void
  memberSearch:   string
  setMemberSearch:(s: string) => void
  loading:        boolean
  deletingMemberId: string | null
  onDelete:       (id: string) => void
  onBack:         () => void
  onRefresh:      () => void
  onAddProspects: () => void
  // Modal add
  showAddToList:       boolean
  setShowAddToList:    (b: boolean) => void
  addSearch:           string
  setAddSearch:        (s: string) => void
  addPage:             number
  setAddPage:          (n: number) => void
  addProspects:        Prospect[]
  addProspectsTotal:   number
  loadingAdd:          boolean
  selectedAdd:         Set<string>
  onToggleAdd:         (id: string) => void
  onSelectAllAdd:      () => void
  onDeselectAllAdd:    () => void
  adding:              boolean
  addError:            string | null
  onSubmitAdd:         () => void
}

function DetailView({
  list, members, membersTotal, memberPage, setMemberPage, memberSearch, setMemberSearch,
  loading, deletingMemberId, onDelete, onBack, onRefresh, onAddProspects,
  showAddToList, setShowAddToList, addSearch, setAddSearch, addPage, setAddPage,
  addProspects, addProspectsTotal, loadingAdd, selectedAdd, onToggleAdd,
  onSelectAllAdd, onDeselectAllAdd, adding, addError, onSubmitAdd,
}: DetailViewProps) {
  const MEMBER_LIMIT = 50

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition-colors"
            onClick={onBack}
          >
            <ChevronLeft size={16} /> Listas de Difusión
          </button>
          <span className="text-gray-300">/</span>
          <h2 className="text-base font-semibold text-gray-800">{list.name}</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </Button>
          <Button size="sm" onClick={onAddProspects}>
            <Plus size={14} className="mr-1" /> Agregar prospectos
          </Button>
        </div>
      </div>

      {/* Stats de la lista */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
          <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-1">Prospectos</p>
          <p className="text-2xl font-bold text-gray-800">{list.member_count.toLocaleString()}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
          <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-1">Campañas</p>
          <p className="text-2xl font-bold text-gray-800">{list.campaign_count}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
          <p className="text-[11px] text-gray-400 uppercase tracking-wide mb-1">Último uso</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <Calendar size={14} className="text-gray-400" />
            <p className="text-sm font-medium text-gray-700">{list.last_used_at ? formatDate(list.last_used_at) : '—'}</p>
          </div>
        </div>
      </div>

      {/* Búsqueda en miembros */}
      <div className="relative max-w-xs">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
        <Input
          placeholder="Buscar miembro..."
          className="pl-8 h-8 text-sm"
          value={memberSearch}
          onChange={e => { setMemberSearch(e.target.value) }}
        />
      </div>

      {/* Tabla de miembros */}
      {loading ? (
        <div className="text-sm text-gray-400 py-8 text-center">Cargando…</div>
      ) : members.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 py-14 flex flex-col items-center gap-3 text-gray-400">
          <Users size={32} className="opacity-30" />
          <p className="text-sm">{memberSearch ? 'Sin resultados para esa búsqueda.' : 'Esta lista no tiene prospectos todavía.'}</p>
          {!memberSearch && (
            <Button size="sm" variant="outline" onClick={onAddProspects}>
              <Plus size={13} className="mr-1" /> Agregar prospectos
            </Button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-2.5 font-medium">Teléfono</th>
                <th className="px-4 py-2.5 font-medium">Nombre</th>
                <th className="px-4 py-2.5 font-medium">Email</th>
                <th className="px-4 py-2.5 font-medium">Estado</th>
                <th className="px-4 py-2.5 font-medium">Opt-in</th>
                <th className="px-4 py-2.5 font-medium">Agregado</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {members.map((m, i) => (
                <tr key={m.id} className={`border-b border-gray-50 ${i % 2 === 0 ? '' : 'bg-gray-50/30'}`}>
                  <td className="px-4 py-2.5 font-mono text-[12px] text-gray-700">{m.phone_number}</td>
                  <td className="px-4 py-2.5 text-gray-700">
                    {[m.first_name, m.last_name].filter(Boolean).join(' ') || <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-gray-500 text-[12px]">{m.email || <span className="text-gray-300">—</span>}</td>
                  <td className="px-4 py-2.5">
                    <Badge
                      variant={m.status === 'active' ? 'default' : 'secondary'}
                      className="text-[10px]"
                    >
                      {m.status === 'active' ? 'activo' : 'baja'}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`text-[11px] font-medium ${m.opt_in ? 'text-green-600' : 'text-red-400'}`}>
                      {m.opt_in ? 'Sí' : 'No'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-400 text-[12px]">{formatDateTime(m.added_at)}</td>
                  <td className="px-4 py-2.5">
                    <button
                      className="p-1 text-gray-300 hover:text-red-500 transition-colors rounded disabled:opacity-40"
                      title="Quitar de la lista"
                      disabled={deletingMemberId === m.id}
                      onClick={() => onDelete(m.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Paginación miembros */}
      {membersTotal > MEMBER_LIMIT && (
        <div className="flex items-center justify-end gap-2 text-sm text-gray-500">
          <button disabled={memberPage === 1} onClick={() => setMemberPage(memberPage - 1)}
            className="px-3 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40">←</button>
          <span>Página {memberPage} de {Math.ceil(membersTotal / MEMBER_LIMIT)}</span>
          <button disabled={memberPage * MEMBER_LIMIT >= membersTotal} onClick={() => setMemberPage(memberPage + 1)}
            className="px-3 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40">→</button>
        </div>
      )}

      {/* Modal agregar prospectos a la lista */}
      <Dialog open={showAddToList} onOpenChange={v => { if (!v) setShowAddToList(false) }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Agregar prospectos a "{list.name}"</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 overflow-hidden flex-1 min-h-0">
            <div className="flex items-center justify-between gap-2">
              <div className="relative flex-1">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <Input
                  placeholder="Buscar prospectos..."
                  className="pl-8 h-8 text-sm"
                  value={addSearch}
                  onChange={e => { setAddSearch(e.target.value); setAddPage(1) }}
                />
              </div>
              <div className="flex items-center gap-1.5 text-xs text-gray-500 shrink-0">
                <button className="text-blue-600 hover:underline" onClick={onSelectAllAdd}>
                  <CheckSquare size={12} className="inline mr-0.5" /> Seleccionar página
                </button>
                {selectedAdd.size > 0 && (
                  <button className="text-gray-400 hover:text-red-500" onClick={onDeselectAllAdd}>
                    <X size={12} className="inline mr-0.5" /> Limpiar ({selectedAdd.size})
                  </button>
                )}
              </div>
            </div>

            <div className="overflow-y-auto flex-1 rounded-lg border border-gray-200 min-h-0">
              {loadingAdd ? (
                <div className="text-sm text-gray-400 py-8 text-center">Cargando…</div>
              ) : addProspects.length === 0 ? (
                <div className="text-sm text-gray-400 py-8 text-center">Sin resultados</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50 border-b border-gray-100 text-xs text-gray-500">
                    <tr>
                      <th className="w-8 px-3 py-2" />
                      <th className="px-3 py-2 text-left font-medium">Teléfono</th>
                      <th className="px-3 py-2 text-left font-medium">Nombre</th>
                      <th className="px-3 py-2 text-left font-medium">Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {addProspects.map(p => {
                      const checked = selectedAdd.has(p.id)
                      return (
                        <tr
                          key={p.id}
                          className={`border-b border-gray-50 cursor-pointer hover:bg-blue-50/30 ${checked ? 'bg-blue-50' : ''}`}
                          onClick={() => onToggleAdd(p.id)}
                        >
                          <td className="px-3 py-2 text-center">
                            <input type="checkbox" readOnly checked={checked} className="accent-blue-600 cursor-pointer" />
                          </td>
                          <td className="px-3 py-2 font-mono text-[12px] text-gray-700">{p.phone_number}</td>
                          <td className="px-3 py-2 text-gray-700">
                            {[p.first_name, p.last_name].filter(Boolean).join(' ') || <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-3 py-2">
                            <Badge variant={p.opt_in ? 'default' : 'secondary'} className="text-[10px]">
                              {p.status === 'active' ? 'activo' : 'baja'}
                            </Badge>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {addProspectsTotal > 50 && (
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>{addProspectsTotal.toLocaleString()} prospectos totales</span>
                <div className="flex items-center gap-2">
                  <button disabled={addPage === 1} onClick={() => setAddPage(addPage - 1)}
                    className="px-2 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40">←</button>
                  <span>Pág. {addPage}</span>
                  <button disabled={addPage * 50 >= addProspectsTotal} onClick={() => setAddPage(addPage + 1)}
                    className="px-2 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40">→</button>
                </div>
              </div>
            )}

            {addError && <p className="text-xs text-red-500">{addError}</p>}
          </div>
          <DialogFooter className="pt-2">
            <span className="text-xs text-gray-400 mr-auto">{selectedAdd.size} seleccionado{selectedAdd.size !== 1 ? 's' : ''}</span>
            <Button variant="outline" onClick={() => setShowAddToList(false)}>Cancelar</Button>
            <Button onClick={onSubmitAdd} disabled={adding || selectedAdd.size === 0}>
              {adding ? 'Agregando…' : `Agregar ${selectedAdd.size > 0 ? selectedAdd.size : ''}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
