'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import * as XLSX from 'xlsx'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Search, Upload, RefreshCw, List, CheckSquare, X, Users, UserPlus, Trash2, Download } from 'lucide-react'

interface Contact {
  id: string; phone_number: string; first_name: string; last_name: string
  email: string; status: string; opt_in: boolean; created_at: string; segment: string; panel: string; gaming: string; linea: number | null
}
interface ImportRow { phone: string; name?: string; segment?: string }
interface ContactList { id: string; name: string; contact_count: number; created_at: string }

export default function Contacts() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [total, setTotal]       = useState(0)
  const [search, setSearch]     = useState('')
  const [segment, setSegment]   = useState('')
  const [filterGaming, setFilterGaming] = useState('')
  const [filterPanel, setFilterPanel]   = useState('')
  const [filterLinea, setFilterLinea]   = useState('')
  const [page, setPage]         = useState(1)
  const [loading, setLoading]     = useState(false)
  const [selected, setSelected]   = useState<Set<string>>(new Set())
  const [lists, setLists]       = useState<ContactList[]>([])

  // Import modal
  const [showImport, setShowImport]   = useState(false)
  const [importRows, setImportRows]   = useState<ImportRow[]>([])
  const [importPanel, setImportPanel]   = useState('')
  const [importGaming, setImportGaming] = useState('')
  const [importing, setImporting]     = useState(false)
  const [importResult, setImportResult] = useState<{ inserted: number; updated: number; skipped: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Add contact modal
  const [showAdd, setShowAdd]       = useState(false)
  const [newPhone, setNewPhone]     = useState('')
  const [newName, setNewName]       = useState('')
  const [newPanel, setNewPanel]     = useState('')
  const [newGaming, setNewGaming]   = useState('')
  const [newSegment, setNewSegment] = useState('')
  const [newLinea, setNewLinea]     = useState('')
  const [addError, setAddError]     = useState('')
  const [addSaving, setAddSaving]   = useState(false)

  // List modal
  const [showList, setShowList]       = useState(false)
  const [listMode, setListMode]       = useState<'selection' | 'criteria'>('selection')
  const [newListName, setNewListName] = useState('')
  const [savingList, setSavingList]   = useState(false)
  const [listError, setListError]     = useState<string | null>(null)
  const [criteriaPanel, setCriteriaPanel]     = useState('')
  const [criteriaGaming, setCriteriaGaming]   = useState('')
  const [criteriaSegment, setCriteriaSegment] = useState('')

  // Inline update / import error
  const [updateError, setUpdateError]   = useState<string | null>(null)
  const [importError, setImportError]   = useState<string | null>(null)

  const PANEL_OPTIONS = ['Betcoin', 'Zeus', 'Bigwin', 'Farabet', 'Las Vegas']

  const SEGMENT_STYLE: Record<string, string> = {
    casual:  'bg-gray-100 text-gray-600',
    regular: 'bg-blue-100 text-blue-700',
    vip:     'bg-purple-100 text-purple-700',
    premium: 'bg-amber-100 text-amber-700',
  }

  const GAMING_STYLE: Record<string, string> = {
    slots:      'bg-pink-100 text-pink-700',
    deportivas: 'bg-green-100 text-green-700',
    ambas:      'bg-cyan-100 text-cyan-700',
  }

  const load = useCallback(() => {
    setLoading(true)
    const q = new URLSearchParams({
      q: search,
      page: String(page),
      segment,
      gaming: filterGaming,
      panel: filterPanel.trim(),
      linea: filterLinea,
    })
    fetch(`/api/contacts?${q}`)
      .then(r => r.json())
      .then(d => { setContacts(d.contacts || []); setTotal(d.total || 0) })
      .finally(() => setLoading(false))
  }, [search, page, segment, filterGaming, filterPanel, filterLinea])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    fetch('/api/lists').then(r => r.json()).then(d => setLists(d.lists || []))
  }, [])

  // Parse CSV o Excel
  const handleFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const data = e.target?.result
      let rows: ImportRow[] = []

      if (file.name.endsWith('.csv')) {
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
          const keys = Object.keys(row).map(k => k.toLowerCase())
          const phoneKey = Object.keys(row).find(k => k.toLowerCase().includes('phone') || k.toLowerCase().includes('tel') || k.toLowerCase().includes('celular') || k.toLowerCase().includes('numero')) || ''
          const nameKey  = Object.keys(row).find(k => k.toLowerCase().includes('name') || k.toLowerCase().includes('nombre')) || ''
          const segKey   = Object.keys(row).find(k => k.toLowerCase().includes('segment') || k.toLowerCase().includes('grupo')) || ''
          void keys
          return { phone: String(row[phoneKey] || ''), name: row[nameKey] || undefined, segment: row[segKey] || undefined }
        }).filter(r => r.phone)
      }
      setImportRows(rows)
    }
    if (file.name.endsWith('.csv')) reader.readAsText(file)
    else reader.readAsBinaryString(file)
  }

  const confirmImport = async () => {
    setImporting(true)
    setImportError(null)
    let res: Response
    try {
      res = await fetch('/api/contacts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contacts: importRows, panel: importPanel || undefined, gaming: importGaming || undefined }),
      })
    } catch {
      setImporting(false)
      setImportError('Error de red al importar')
      return
    }
    const data = await res.json().catch(() => ({}))
    setImporting(false)
    if (!res.ok) {
      setImportError(data.error || 'Error al importar')
      return
    }
    setImportResult(data)
    load()
  }

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const updatePanel = async (contactId: string, panel: string | null) => {
    const old = contacts.find(c => c.id === contactId)?.panel ?? ''
    setContacts(cs => cs.map(c => c.id === contactId ? { ...c, panel: panel || '' } : c))
    const res = await fetch(`/api/contacts/${contactId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ panel }),
    })
    if (!res.ok) {
      setContacts(cs => cs.map(c => c.id === contactId ? { ...c, panel: old } : c))
      setUpdateError('Error al actualizar panel')
    }
  }

  const updateSegment = async (contactId: string, segment: string | null) => {
    const old = contacts.find(c => c.id === contactId)?.segment ?? ''
    setContacts(cs => cs.map(c => c.id === contactId ? { ...c, segment: segment || '' } : c))
    const res = await fetch(`/api/contacts/${contactId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segment }),
    })
    if (!res.ok) {
      setContacts(cs => cs.map(c => c.id === contactId ? { ...c, segment: old } : c))
      setUpdateError('Error al actualizar nivel')
    }
  }

  const updateGaming = async (contactId: string, gaming: string | null) => {
    const old = contacts.find(c => c.id === contactId)?.gaming ?? ''
    setContacts(cs => cs.map(c => c.id === contactId ? { ...c, gaming: gaming || '' } : c))
    const res = await fetch(`/api/contacts/${contactId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gaming }),
    })
    if (!res.ok) {
      setContacts(cs => cs.map(c => c.id === contactId ? { ...c, gaming: old } : c))
      setUpdateError('Error al actualizar juego')
    }
  }

  const updateLinea = async (contactId: string, linea: number | null) => {
    const old = contacts.find(c => c.id === contactId)?.linea ?? null
    setContacts(cs => cs.map(c => c.id === contactId ? { ...c, linea } : c))
    const res = await fetch(`/api/contacts/${contactId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linea }),
    })
    if (!res.ok) {
      setContacts(cs => cs.map(c => c.id === contactId ? { ...c, linea: old } : c))
      setUpdateError('Error al actualizar línea')
    }
  }

  const addContact = async () => {
    if (!newPhone.trim()) { setAddError('El teléfono es obligatorio'); return }
    setAddSaving(true); setAddError('')
    const res = await fetch('/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: newPhone, name: newName, panel: newPanel, gaming: newGaming || null, segment: newSegment || null, linea: newLinea ? Number(newLinea) : null }),
    })
    const data = await res.json()
    setAddSaving(false)
    if (!res.ok) { setAddError(data.error || 'Error al guardar'); return }
    setShowAdd(false); setNewPhone(''); setNewName(''); setNewPanel(''); setNewGaming(''); setNewSegment(''); setNewLinea(''); setAddError('')
    load()
  }

  const deleteContact = async (id: string) => {
    if (!confirm('¿Eliminar este contacto?')) return
    const res = await fetch(`/api/contacts/${id}`, { method: 'DELETE' })
    if (!res.ok) return  // don't remove from UI if server rejected
    setContacts(prev => prev.filter(c => c.id !== id))
    setTotal(prev => prev - 1)
    setSelected(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  const deleteSelected = async () => {
    if (!confirm(`¿Eliminar ${selected.size} contactos seleccionados?`)) return
    const ids = Array.from(selected)
    const responses = await Promise.all(
      ids.map(id => fetch(`/api/contacts/${id}`, { method: 'DELETE' })
        .then(r => ({ id, ok: r.ok }))
        .catch(() => ({ id, ok: false })))
    )
    const deleted = new Set(responses.filter(r => r.ok).map(r => r.id))
    if (deleted.size === 0) return
    setContacts(prev => prev.filter(c => !deleted.has(c.id)))
    setTotal(prev => prev - deleted.size)
    setSelected(new Set())
  }

  const [downloading, setDownloading] = useState(false)

  const downloadContacts = async (format: 'csv' | 'xlsx') => {
    setDownloading(true)
    const q = new URLSearchParams({
      q: search, segment, gaming: filterGaming,
      panel: filterPanel.trim(), linea: filterLinea, download: 'true',
    })
    const d = await fetch(`/api/contacts?${q}`).then(r => r.json())
    const rows: Contact[] = d.contacts || []

    const data = rows.map(c => ({
      'Teléfono':   c.phone_number,
      'Nombre':     [c.first_name, c.last_name].filter(Boolean).join(' ') || '',
      'Email':      c.email || '',
      'Panel':      c.panel || '',
      'Línea':      c.linea ?? '',
      'Juego':      c.gaming || '',
      'Nivel':      c.segment || '',
      'Estado':     c.status || '',
      'Fecha alta': c.created_at ? new Date(c.created_at).toLocaleDateString('es-AR') : '',
    }))

    const ws  = XLSX.utils.json_to_sheet(data)
    const wb  = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Contactos')

    // Column widths
    ws['!cols'] = [14, 22, 24, 12, 8, 12, 10, 10, 12].map(w => ({ wch: w }))

    const filters = [
      filterPanel && `panel-${filterPanel}`,
      filterGaming && `juego-${filterGaming}`,
      segment && `nivel-${segment}`,
      search && `busq-${search}`,
    ].filter(Boolean).join('_') || 'todos'

    const filename = `contactos_${filters}_${new Date().toISOString().slice(0,10)}.${format}`

    if (format === 'csv') {
      const csv = XLSX.utils.sheet_to_csv(ws)
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a'); a.href = url; a.download = filename; a.click()
      URL.revokeObjectURL(url)
    } else {
      XLSX.writeFile(wb, filename)
    }
    setDownloading(false)
  }

  const createList = async () => {
    if (!newListName) return
    if (listMode === 'selection' && selected.size === 0) return
    if (listMode === 'criteria' && !criteriaPanel && !criteriaGaming && !criteriaSegment) return
    setSavingList(true)
    setListError(null)
    const body = listMode === 'selection'
      ? { name: newListName, contact_ids: Array.from(selected) }
      : { name: newListName, criteria: { panel: criteriaPanel, gaming: criteriaGaming, segment: criteriaSegment } }
    const res = await fetch('/api/lists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    setSavingList(false)
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      setListError(d.error || 'Error al crear la lista')
      return
    }
    setShowList(false)
    setNewListName('')
    setSelected(new Set())
    setCriteriaPanel(''); setCriteriaGaming(''); setCriteriaSegment('')
    fetch('/api/lists').then(r => r.json()).then(d => setLists(d.lists || []))
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Contactos</h1>
          <p className="text-sm text-gray-500">{total.toLocaleString()} contactos{selected.size > 0 && ` · ${selected.size} seleccionados`}</p>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </Button>
          <div className="relative group">
            <Button variant="outline" size="sm" disabled={downloading} className="border-teal-200 text-teal-700 hover:bg-teal-50">
              <Download size={14} className={`mr-1 ${downloading ? 'animate-bounce' : ''}`} />
              {downloading ? 'Descargando…' : 'Descargar'}
            </Button>
            <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 hidden group-hover:block min-w-36">
              <button onClick={() => downloadContacts('xlsx')}
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2 rounded-t-lg">
                <span className="text-green-600 font-bold text-xs">XLS</span> Excel (.xlsx)
              </button>
              <button onClick={() => downloadContacts('csv')}
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2 rounded-b-lg border-t border-gray-100">
                <span className="text-blue-600 font-bold text-xs">CSV</span> CSV (.csv)
              </button>
            </div>
          </div>
          {selected.size > 0 && (
            <Button size="sm" variant="outline" onClick={deleteSelected} className="border-red-200 text-red-600 hover:bg-red-50">
              <Trash2 size={14} className="mr-1" /> Eliminar ({selected.size})
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => { setListMode('criteria'); setShowList(true) }} className="border-indigo-200 text-indigo-700">
            <List size={14} className="mr-1" /> Lista por criterios
          </Button>
          {selected.size > 0 && (
            <Button size="sm" variant="outline" onClick={() => { setListMode('selection'); setShowList(true) }} className="border-green-200 text-green-700">
              <List size={14} className="mr-1" /> Crear lista ({selected.size})
            </Button>
          )}
          <Button size="sm" onClick={() => setShowAdd(true)} className="bg-green-600 hover:bg-green-700 text-white">
            <UserPlus size={14} className="mr-1" /> Nuevo contacto
          </Button>
          <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-md bg-white hover:bg-gray-50 transition-colors font-medium">
            <Upload size={14} /> Importar
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if(f){ handleFile(f); setShowImport(true); e.target.value=''; }}} />
          </label>
        </div>
      </div>

      {/* Error de actualización inline */}
      {updateError && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2 text-sm text-red-600 flex items-center justify-between">
          <span>{updateError}</span>
          <button onClick={() => setUpdateError(null)} className="ml-4 text-red-400 hover:text-red-600">✕</button>
        </div>
      )}

      {/* Filtros */}
      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input className="pl-9" placeholder="Buscar por nombre o teléfono…" value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }} />
        </div>
        <Select value={filterPanel} onValueChange={v => { setFilterPanel(v ?? ''); setPage(1) }}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Panel" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Todos los paneles</SelectItem>
            {PANEL_OPTIONS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filterLinea} onValueChange={v => { setFilterLinea(v ?? ''); setPage(1) }}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="Línea" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Todas las líneas</SelectItem>
            {Array.from({ length: 12 }, (_, i) => i + 1).map(n => (
              <SelectItem key={n} value={String(n)}>Línea {n}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterGaming} onValueChange={v => { setFilterGaming(v ?? ''); setPage(1) }}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Juego" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Todos los juegos</SelectItem>
            <SelectItem value="slots">🎰 Slots</SelectItem>
            <SelectItem value="deportivas">⚽ Deportivas</SelectItem>
            <SelectItem value="ambas">🎯 Ambas</SelectItem>
          </SelectContent>
        </Select>
        <Select value={segment} onValueChange={v => { setSegment(v ?? ''); setPage(1) }}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Nivel" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Todos los niveles</SelectItem>
            {['casual','regular','vip','premium'].map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* Listas existentes */}
      {lists.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {lists.map(l => (
            <Badge key={l.id} variant="outline" className="cursor-pointer gap-1 py-1 px-2">
              <Users size={11} /> {l.name} <span className="text-gray-400">({l.contact_count})</span>
            </Badge>
          ))}
        </div>
      )}

      {/* Tabla */}
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="px-4 py-3 w-8">
                  <input type="checkbox" className="rounded"
                    checked={selected.size === contacts.length && contacts.length > 0}
                    onChange={e => setSelected(e.target.checked ? new Set(contacts.map(c=>c.id)) : new Set())} />
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Teléfono</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Nombre</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Panel</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Línea</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Juego</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Nivel</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Estado</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Opt-in</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Alta</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody>
              {contacts.length === 0
                ? <tr><td colSpan={10} className="text-center py-10 text-gray-400">
                    {loading ? 'Cargando…' : 'Sin contactos'}
                  </td></tr>
                : contacts.map(c => (
                  <tr key={c.id} className={`border-b border-gray-100 hover:bg-gray-50 ${selected.has(c.id) ? 'bg-green-50' : ''}`}>
                    <td className="px-4 py-3">
                      <input type="checkbox" className="rounded" checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{c.phone_number}</td>
                    <td className="px-4 py-3">{[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}</td>
                    <td className="px-4 py-3">
                      <select
                        value={c.panel || ''}
                        onChange={e => updatePanel(c.id, e.target.value || null)}
                        className={`text-xs px-2 py-0.5 rounded-full font-medium border-0 cursor-pointer appearance-none bg-transparent focus:outline-none focus:ring-1 focus:ring-offset-0 focus:ring-gray-300 ${c.panel ? 'bg-indigo-50 text-indigo-700' : 'text-gray-400'}`}
                      >
                        <option value="">— sin panel</option>
                        {PANEL_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </td>
                    {/* Columna Línea — editable con un click */}
                    <td className="px-4 py-3">
                      <select
                        value={c.linea ?? ''}
                        onChange={e => updateLinea(c.id, e.target.value ? Number(e.target.value) : null)}
                        className={`text-xs px-2 py-0.5 rounded-full font-medium border-0 cursor-pointer appearance-none bg-transparent focus:outline-none focus:ring-1 focus:ring-offset-0 focus:ring-gray-300 ${c.linea ? 'bg-orange-50 text-orange-700' : 'text-gray-400'}`}
                      >
                        <option value="">— sin línea</option>
                        {Array.from({ length: 12 }, (_, i) => i + 1).map(n => (
                          <option key={n} value={n}>Línea {n}</option>
                        ))}
                      </select>
                    </td>
                    {/* Columna Juego — editable con un click */}
                    <td className="px-4 py-3">
                      <select
                        value={c.gaming || ''}
                        onChange={e => updateGaming(c.id, e.target.value || null)}
                        className={`text-xs px-2 py-0.5 rounded-full font-medium border-0 cursor-pointer appearance-none bg-transparent focus:outline-none focus:ring-1 focus:ring-offset-0 focus:ring-gray-300 ${c.gaming ? GAMING_STYLE[c.gaming] : 'text-gray-400'}`}
                      >
                        <option value="">— sin asignar</option>
                        <option value="slots">🎰 Slots</option>
                        <option value="deportivas">⚽ Deportivas</option>
                        <option value="ambas">🎯 Ambas</option>
                      </select>
                    </td>
                    {/* Columna Segmento — editable con un click */}
                    <td className="px-4 py-3">
                      <select
                        value={c.segment || ''}
                        onChange={e => updateSegment(c.id, e.target.value || null)}
                        className={`text-xs px-2 py-0.5 rounded-full font-medium border-0 cursor-pointer appearance-none bg-transparent focus:outline-none focus:ring-1 focus:ring-offset-0 focus:ring-gray-300 ${c.segment ? SEGMENT_STYLE[c.segment] : 'text-gray-400'}`}
                      >
                        <option value="">— sin nivel</option>
                        <option value="casual">casual</option>
                        <option value="regular">regular</option>
                        <option value="vip">vip</option>
                        <option value="premium">premium</option>
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={c.status === 'active' ? 'default' : 'secondary'}
                             className={`text-xs ${c.status === 'active' ? 'bg-green-100 text-green-700' : ''}`}>
                        {c.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium ${c.opt_in ? 'text-green-600' : 'text-gray-400'}`}>
                        {c.opt_in ? '✓' : '✗'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {new Date(c.created_at).toLocaleDateString('es-AR')}
                    </td>
                    <td className="px-2 py-3">
                      <button onClick={() => deleteContact(c.id)} className="text-gray-300 hover:text-red-500 transition-colors p-1 rounded">
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </CardContent>
      </Card>

      {total > 50 && (
        <div className="flex justify-center gap-2">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => p-1)}>Anterior</Button>
          <span className="text-sm text-gray-500 self-center">Pág. {page} de {Math.ceil(total/50)}</span>
          <Button variant="outline" size="sm" disabled={page*50 >= total} onClick={() => setPage(p => p+1)}>Siguiente</Button>
        </div>
      )}

      {/* Modal importación */}
      <Dialog open={showImport} onOpenChange={v => {
        if (importing) return  // block close during import
        setShowImport(v)
        if (!v) {
          setImportRows([])
          setImportResult(null)
          setImporting(false)
          setImportError(null)
          setImportPanel('')
          setImportGaming('')
        }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Upload size={16}/> Importar contactos</DialogTitle>
          </DialogHeader>
          {importResult ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="bg-green-50 rounded-lg p-4"><p className="text-2xl font-bold text-green-600">{importResult.inserted}</p><p className="text-xs text-gray-500">Creados</p></div>
                <div className="bg-blue-50 rounded-lg p-4"><p className="text-2xl font-bold text-blue-600">{importResult.updated}</p><p className="text-xs text-gray-500">Actualizados</p></div>
                <div className="bg-gray-50 rounded-lg p-4"><p className="text-2xl font-bold text-gray-500">{importResult.skipped}</p><p className="text-xs text-gray-500">Omitidos</p></div>
              </div>
              <Button className="w-full" onClick={() => { setShowImport(false); setImportRows([]); setImportResult(null); setImportPanel(''); setImportGaming('') }}>Cerrar</Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-gray-500">
                {importRows.length} contactos detectados. Columnas reconocidas: <code className="bg-gray-100 px-1 rounded">phone/tel/numero</code>, <code className="bg-gray-100 px-1 rounded">name/nombre</code>, <code className="bg-gray-100 px-1 rounded">segment/grupo</code>
              </p>
              <div className="max-h-64 overflow-y-auto border rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0"><tr>
                    <th className="text-left px-3 py-2 font-medium">Teléfono</th>
                    <th className="text-left px-3 py-2 font-medium">Nombre</th>
                    <th className="text-left px-3 py-2 font-medium">Nivel</th>
                  </tr></thead>
                  <tbody>
                    {importRows.slice(0,50).map((r,i) => (
                      <tr key={i} className="border-t border-gray-100">
                        <td className="px-3 py-1.5 font-mono text-xs">{r.phone}</td>
                        <td className="px-3 py-1.5">{r.name || '—'}</td>
                        <td className="px-3 py-1.5">{r.segment || '—'}</td>
                      </tr>
                    ))}
                    {importRows.length > 50 && <tr><td colSpan={3} className="px-3 py-2 text-gray-400 text-xs">…y {importRows.length-50} más</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Panel (opcional)</label>
                  <Input
                    placeholder="Ej: RoyalBet, Panel VIP…"
                    value={importPanel}
                    onChange={e => setImportPanel(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">Tipo de juego (opcional)</label>
                  <Select value={importGaming} onValueChange={v => setImportGaming(v === 'none' ? '' : (v ?? ''))}>
                    <SelectTrigger><SelectValue placeholder="Sin asignar" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Sin asignar</SelectItem>
                      <SelectItem value="slots">🎰 Slots</SelectItem>
                      <SelectItem value="deportivas">⚽ Deportivas</SelectItem>
                      <SelectItem value="ambas">🎯 Ambas</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <p className="text-xs text-gray-400 -mt-2">Se asignarán a todos los contactos importados</p>
              {importError && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{importError}</p>
              )}
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
        if (savingList) return  // block close during save
        setShowList(v)
        if (!v) {
          setNewListName('')
          setListMode('selection')
          setCriteriaPanel('')
          setCriteriaGaming('')
          setCriteriaSegment('')
          setSavingList(false)
          setListError(null)
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><CheckSquare size={16}/> Crear lista de distribución</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Tabs modo */}
            <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
              <button
                onClick={() => setListMode('selection')}
                className={`flex-1 py-2 font-medium transition-colors ${listMode === 'selection' ? 'bg-green-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}>
                Desde selección {selected.size > 0 && `(${selected.size})`}
              </button>
              <button
                onClick={() => setListMode('criteria')}
                className={`flex-1 py-2 font-medium transition-colors ${listMode === 'criteria' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}>
                Por criterios
              </button>
            </div>

            {listMode === 'selection' ? (
              <p className="text-sm text-gray-500">
                {selected.size === 0
                  ? 'Seleccioná contactos en la tabla primero.'
                  : `${selected.size} contactos seleccionados manualmente.`}
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-gray-400">Se incluirán todos los contactos que cumplan los criterios elegidos.</p>
                <div className="grid grid-cols-1 gap-2">
                  <div>
                    <label className="text-xs font-medium text-gray-600 mb-1 block">Panel</label>
                    <Select value={criteriaPanel || 'all'} onValueChange={v => setCriteriaPanel(v === 'all' ? '' : (v ?? ''))}>
                      <SelectTrigger><SelectValue placeholder="Cualquier panel" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Cualquier panel</SelectItem>
                        {PANEL_OPTIONS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 mb-1 block">Juego</label>
                    <Select value={criteriaGaming || 'all'} onValueChange={v => setCriteriaGaming(v === 'all' ? '' : (v ?? ''))}>
                      <SelectTrigger><SelectValue placeholder="Cualquier juego" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Cualquier juego</SelectItem>
                        <SelectItem value="slots">🎰 Slots</SelectItem>
                        <SelectItem value="deportivas">⚽ Deportivas</SelectItem>
                        <SelectItem value="ambas">🎯 Ambas</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 mb-1 block">Nivel</label>
                    <Select value={criteriaSegment || 'all'} onValueChange={v => setCriteriaSegment(v === 'all' ? '' : (v ?? ''))}>
                      <SelectTrigger><SelectValue placeholder="Cualquier nivel" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Cualquier nivel</SelectItem>
                        <SelectItem value="casual">Casual</SelectItem>
                        <SelectItem value="regular">Regular</SelectItem>
                        <SelectItem value="vip">VIP</SelectItem>
                        <SelectItem value="premium">Premium</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            )}

            <Input placeholder="Nombre de la lista (ej: Betcoin Slots VIP)" value={newListName} onChange={e => setNewListName(e.target.value)} />

            {listError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">{listError}</p>
            )}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setShowList(false)} disabled={savingList}><X size={14}/> Cancelar</Button>
              <Button
                className={`flex-1 ${listMode === 'criteria' ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-green-600 hover:bg-green-700'}`}
                onClick={createList}
                disabled={savingList || !newListName || (listMode === 'selection' && selected.size === 0) || (listMode === 'criteria' && !criteriaPanel && !criteriaGaming && !criteriaSegment)}>
                {savingList ? 'Guardando…' : 'Crear lista'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Modal nuevo contacto */}
      <Dialog open={showAdd} onOpenChange={v => {
        setShowAdd(v)
        if (!v) {
          setNewPhone('')
          setNewName('')
          setNewPanel('')
          setNewGaming('')
          setNewSegment('')
          setNewLinea('')
          setAddError('')
          setAddSaving(false)
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><UserPlus size={16}/> Nuevo contacto</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Teléfono <span className="text-red-500">*</span></label>
              <Input placeholder="Ej: 5492236123456" value={newPhone} onChange={e => setNewPhone(e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Nombre completo</label>
              <Input placeholder="Ej: Juan Pérez" value={newName} onChange={e => setNewName(e.target.value)} />
            </div>
            <div className="grid grid-cols-4 gap-2">
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Panel</label>
                <Select value={newPanel} onValueChange={v => setNewPanel(v ?? '')}>
                  <SelectTrigger><SelectValue placeholder="Panel" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Sin panel</SelectItem>
                    {PANEL_OPTIONS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Línea</label>
                <Select value={newLinea} onValueChange={v => setNewLinea(v ?? '')}>
                  <SelectTrigger><SelectValue placeholder="Línea" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Sin línea</SelectItem>
                    {Array.from({ length: 12 }, (_, i) => i + 1).map(n => (
                      <SelectItem key={n} value={String(n)}>Línea {n}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Juego</label>
                <Select value={newGaming} onValueChange={v => setNewGaming(v ?? '')}>
                  <SelectTrigger><SelectValue placeholder="Juego" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Sin asignar</SelectItem>
                    <SelectItem value="slots">🎰 Slots</SelectItem>
                    <SelectItem value="deportivas">⚽ Deportivas</SelectItem>
                    <SelectItem value="ambas">🎯 Ambas</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">Nivel</label>
                <Select value={newSegment} onValueChange={v => setNewSegment(v ?? '')}>
                  <SelectTrigger><SelectValue placeholder="Nivel" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Sin nivel</SelectItem>
                    <SelectItem value="casual">Casual</SelectItem>
                    <SelectItem value="regular">Regular</SelectItem>
                    <SelectItem value="vip">VIP</SelectItem>
                    <SelectItem value="premium">Premium</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {addError && <p className="text-xs text-red-500">{addError}</p>}
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setShowAdd(false)}><X size={14}/> Cancelar</Button>
              <Button className="flex-1 bg-green-600 hover:bg-green-700" onClick={addContact} disabled={addSaving}>
                {addSaving ? 'Guardando…' : 'Guardar contacto'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
