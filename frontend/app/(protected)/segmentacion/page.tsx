'use client'
import { useState, useCallback } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Search, Download, Filter, Loader2 } from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'
import { PageHeader } from '@/components/layout/PageHeader'

const PANEL_OPTIONS = ['betcoin', 'bigwin', 'farabet', 'ofizeus', 'royal']

const NIVEL_LABEL: Record<string, string> = {
  bajo: 'Bajo', medio: 'Medio', alto: 'VIP', vip_medio: 'VIP Medio', vip_alto: 'VIP Alto', super_vip: 'Super VIP',
}

const INACTIVIDAD_OPTIONS = [
  { value: '', label: 'Cualquier inactividad' },
  { value: '7',  label: '+7 días' },
  { value: '15', label: '+15 días' },
  { value: '30', label: '+30 días' },
  { value: '45', label: '+45 días' },
  { value: '60', label: '+60 días' },
  { value: '90', label: '+90 días' },
]

interface PreviewContact {
  id: string; phone_number: string; first_name: string; last_name: string
  panel: string; linea: number | null; segment: string; total_deposits: number | null
}

export default function SegmentacionPage() {
  const [panel, setPanel]             = useState('')
  const [linea, setLinea]             = useState('')
  const [plataforma, setPlataforma]   = useState('')
  const [segment, setSegment]         = useState('')
  const [inactividad, setInactividad] = useState('')

  const [loading, setLoading]   = useState(false)
  const [results, setResults]   = useState<PreviewContact[] | null>(null)
  const [total, setTotal]       = useState(0)
  const [error, setError]       = useState('')

  const buildParams = useCallback((extra: Record<string, string> = {}) => {
    const p = new URLSearchParams()
    if (panel)       p.set('panel', panel)
    if (linea)        p.set('linea', linea)
    if (plataforma)   p.set('plataforma', plataforma)
    if (segment)       p.set('segment', segment)
    if (inactividad)   p.set('inactividad_dias', inactividad)
    Object.entries(extra).forEach(([k, v]) => p.set(k, v))
    return p
  }, [panel, linea, plataforma, segment, inactividad])

  const handleSearch = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = buildParams({ page: '1' })
      const data = await fetchJson<{ contacts: PreviewContact[]; total: number }>(`/api/contacts?${params.toString()}`)
      setResults(data.contacts)
      setTotal(data.total)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al buscar contactos')
    } finally {
      setLoading(false)
    }
  }, [buildParams])

  const handleClear = useCallback(() => {
    setPanel(''); setLinea(''); setPlataforma(''); setSegment(''); setInactividad('')
    setResults(null); setTotal(0); setError('')
  }, [])

  const handleExport = useCallback(() => {
    const params = buildParams()
    window.open(`/api/contacts/segment-export?${params.toString()}`, '_blank')
  }, [buildParams])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Segmentación"
        description="Combiná filtros y exportá los resultados a CSV."
      />

      <div className="flex gap-3 flex-wrap items-end">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Oficina</label>
          <Select value={panel} onValueChange={v => setPanel(v ?? '')}>
            <SelectTrigger className="w-40"><SelectValue placeholder="Todas" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">Todas las oficinas</SelectItem>
              {PANEL_OPTIONS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="text-xs text-muted-foreground block mb-1">Línea</label>
          <Select value={linea} onValueChange={v => setLinea(v ?? '')}>
            <SelectTrigger className="w-32"><SelectValue placeholder="Todas" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">Todas las líneas</SelectItem>
              {Array.from({ length: 100 }, (_, i) => i + 1).map(n => (
                <SelectItem key={n} value={String(n)}>Línea {n}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="text-xs text-muted-foreground block mb-1">Plataforma</label>
          <Select value={plataforma} onValueChange={v => setPlataforma(v ?? '')}>
            <SelectTrigger className="w-40"><SelectValue placeholder="Todas" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">Todas las plataformas</SelectItem>
              <SelectItem value="zeus">Zeus</SelectItem>
              <SelectItem value="bet30">Bet30</SelectItem>
              <SelectItem value="otros">Otros</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="text-xs text-muted-foreground block mb-1">Inactividad mínima</label>
          <Select value={inactividad} onValueChange={v => setInactividad(v ?? '')}>
            <SelectTrigger className="w-44"><SelectValue placeholder="Cualquiera" /></SelectTrigger>
            <SelectContent>
              {INACTIVIDAD_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div>
        <label className="text-xs text-muted-foreground block mb-1">Segmento de monto</label>
        <div className="flex gap-2 flex-wrap">
          {Object.entries(NIVEL_LABEL).map(([v, l]) => (
            <button
              key={v}
              onClick={() => setSegment(s => (s === v ? '' : v))}
              className={`text-xs px-3 py-1.5 rounded-full border font-medium transition-colors ${
                segment === v
                  ? 'bg-violet-600 text-white border-violet-600'
                  : 'border-zinc-300 text-zinc-600 hover:border-violet-400'
              }`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <Button onClick={handleSearch} disabled={loading}>
          {loading ? <Loader2 size={15} className="mr-2 animate-spin" /> : <Search size={15} className="mr-2" />}
          Buscar
        </Button>
        <Button variant="outline" onClick={handleClear}>
          <Filter size={15} className="mr-2" /> Limpiar filtros
        </Button>
        <Button
          variant="secondary"
          onClick={handleExport}
          disabled={results === null || total === 0}
          className="ml-auto"
        >
          <Download size={15} className="mr-2" /> Exportar CSV {total > 0 ? `(${total})` : ''}
        </Button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {results !== null && (
        <div className="border rounded-lg overflow-hidden">
          <div className="px-3 py-2 text-xs text-muted-foreground bg-muted/40 border-b">
            {total} resultado{total === 1 ? '' : 's'} {total > results.length ? `(mostrando los primeros ${results.length})` : ''}
          </div>
          <div className="overflow-x-auto max-h-[480px]">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Teléfono</th>
                  <th className="text-left px-3 py-2 font-medium">Nombre</th>
                  <th className="text-left px-3 py-2 font-medium">Oficina</th>
                  <th className="text-left px-3 py-2 font-medium">Línea</th>
                  <th className="text-left px-3 py-2 font-medium">Segmento</th>
                  <th className="text-left px-3 py-2 font-medium">Cargas</th>
                </tr>
              </thead>
              <tbody>
                {results.map(c => (
                  <tr key={c.id} className="border-t">
                    <td className="px-3 py-1.5">{c.phone_number}</td>
                    <td className="px-3 py-1.5">{[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}</td>
                    <td className="px-3 py-1.5">{c.panel || '—'}</td>
                    <td className="px-3 py-1.5">{c.linea ?? '—'}</td>
                    <td className="px-3 py-1.5">{NIVEL_LABEL[c.segment] ?? c.segment ?? '—'}</td>
                    <td className="px-3 py-1.5">{c.total_deposits ?? '—'}</td>
                  </tr>
                ))}
                {results.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">Sin resultados para estos filtros.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
