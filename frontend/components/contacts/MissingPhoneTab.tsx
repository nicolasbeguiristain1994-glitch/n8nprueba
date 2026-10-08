'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Upload, RefreshCw, ChevronLeft, ChevronRight, PhoneOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PageHeader } from '@/components/layout/PageHeader'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { parseMissingContactSheet } from '@/lib/missing-contact-files'
import type { MissingContact, MissingContactImportRow, MissingContactImportResult } from '@/lib/missing-contact-types'

type Listing = { users: MissingContact[]; total: number; agents: string[] }
const selectClass = 'h-10 min-w-0 max-w-full rounded-lg border border-input bg-card px-3 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25'
const date = (value: string | null) => value ? new Date(value.length === 10 ? `${value}T12:00:00-03:00` : value).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : '—'

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'No se pudo completar la operación.')
  return body as T
}

export function MissingPhoneTab({ onImported }: { onImported: () => void }) {
  const { user, permissions } = useCurrentUser()
  const [agent, setAgent] = useState('')
  const [platform, setPlatform] = useState('')
  const [months, setMonths] = useState('6')
  const [includeNew, setIncludeNew] = useState(true)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [data, setData] = useState<Listing>({ users: [], total: 0, agents: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importRows, setImportRows] = useState<MissingContactImportRow[]>([])
  const [result, setResult] = useState<MissingContactImportResult | null>(null)
  const [importError, setImportError] = useState('')
  const [busy, setBusy] = useState(false)
  const [filename, setFilename] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const params = new URLSearchParams({ agent, platform, months, include_new: String(includeNew), q: search, page: String(page) }).toString()

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    const timer = setTimeout(async () => {
      try {
        const body = await readResponse<Listing>(await fetch(`/api/contacts/missing-phone?${params}`, { signal: controller.signal, cache: 'no-store' }))
        if (!controller.signal.aborted) {
          setData(body)
          if (page > 1 && (page - 1) * 50 >= body.total) setPage(Math.max(1, Math.ceil(body.total / 50)))
        }
      } catch (e) { if (!controller.signal.aborted) setError((e as Error).message) }
      finally { if (!controller.signal.aborted) setLoading(false) }
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [params, revision, page])

  // Every entry/revisit queries live sync data; refresh visible lists periodically.
  useEffect(() => {
    const refresh = () => { if (!document.hidden) setRevision(r => r + 1) }
    const timer = setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [])

  const download = async () => {
    setDownloading(true); setError('')
    try {
      const response = await fetch(`/api/contacts/missing-phone?${params}&download=true`)
      if (!response.ok) { await readResponse(response); return }
      const url = URL.createObjectURL(await response.blob())
      const a = document.createElement('a'); a.href = url; a.download = `usuarios-sin-numero-${agent || 'todos'}.xlsx`
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) { setError((e as Error).message) }
    finally { setDownloading(false) }
  }

  const submit = useCallback(async (rows: MissingContactImportRow[], dryRun: boolean) => {
    return readResponse<MissingContactImportResult>(await fetch('/api/contacts/missing-phone/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows, dryRun }),
    }))
  }, [])

  const readFile = async (file: File) => {
    setBusy(true); setImportError(''); setResult(null); setImportRows([]); setFilename(file.name); setImportOpen(true)
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error('El archivo no puede superar 15 MB.')
      const XLSX = await import('xlsx')
      const book = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: true })
      const sheet = book.Sheets[book.SheetNames.find(name => name === 'Usuarios sin número') ?? book.SheetNames[0]]
      if (!sheet) throw new Error('El archivo está vacío.')
      const rows = parseMissingContactSheet(XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false }))
      const preview = await submit(rows, true)
      setImportRows(rows); setResult(preview)
    } catch (e) { setImportError((e as Error).message) }
    finally { setBusy(false) }
  }

  const commit = async () => {
    setBusy(true); setImportError('')
    try {
      const saved = await submit(importRows, false)
      setResult(saved); setRevision(r => r + 1); onImported()
    } catch (e) { setImportError((e as Error).message); setResult(null) }
    finally { setBusy(false) }
  }

  const filter = (change: () => void) => { change(); setPage(1) }
  return <div className="space-y-5">
    <PageHeader title="Usuarios sin número" count={loading ? undefined : data.total}
      description="Usuarios de las plataformas a los que todavía no les vinculamos un celular."
      actions={<>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => setRevision(r => r + 1)}><RefreshCw className="mr-2 size-4" />Actualizar</Button>
        {user?.can_download_contacts && <Button variant="outline" size="sm" disabled={loading || downloading || !data.total} onClick={download}><Download className="mr-2 size-4" />{downloading ? 'Descargando…' : 'Descargar para agentes'}</Button>}
        {permissions.contacts?.includes('create') && <><Button size="sm" disabled={busy} onClick={() => fileRef.current?.click()}><Upload className="mr-2 size-4" />Cargar celulares</Button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="sr-only" aria-label="Cargar planilla de celulares" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void readFile(file) }} /></>}
      </>} />
    <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground space-y-1">
      <p>1. Filtrá por agente y descargá la planilla. 2. El agente completa la columna <strong>Celular</strong>. 3. Cargá el archivo para incorporarlos a Contactos.</p>
      <p>Incluye cargas y retiros del período, y nuevos usuarios detectados por la sincronización. La lista se actualiza automáticamente cada minuto. La cobertura depende de las plataformas sincronizadas.</p>
    </div>
    <div className="filter-bar">
      <Input aria-label="Buscar usuario sin número" placeholder="Buscar usuario…" className="w-full sm:w-64" value={search} onChange={e => filter(() => setSearch(e.target.value))} />
      <select aria-label="Agente de usuarios sin número" className={selectClass} value={agent} onChange={e => filter(() => setAgent(e.target.value))}>
        <option value="">Todos los agentes</option>{data.agents.map(a => <option key={a} value={a}>{a}</option>)}
      </select>
      <select aria-label="Plataforma de usuarios sin número" className={selectClass} value={platform} onChange={e => filter(() => setPlatform(e.target.value))}>
        <option value="">Todas las plataformas</option>{['zeus', 'bet30', 'ganamos', 'argenbet'].map(p => <option key={p} value={p}>{p}</option>)}
      </select>
      <select aria-label="Período de usuarios sin número" className={selectClass} value={months} onChange={e => filter(() => setMonths(e.target.value))}>
        {[1, 3, 6, 12, 24].map(n => <option key={n} value={n}>Últimos {n} {n === 1 ? 'mes' : 'meses'}</option>)}<option value="0">Todo el historial</option>
      </select>
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={includeNew} onCheckedChange={v => filter(() => setIncludeNew(v === true))} />Incluir nuevos sin movimientos</label>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {loading ? <p role="status" className="py-10 text-center text-muted-foreground">Buscando usuarios sin número…</p> : !error && <>
      {!data.users.length ? <div className="surface p-10 text-center space-y-2"><PhoneOff className="mx-auto size-8 text-muted-foreground" /><p>No hay usuarios pendientes con estos filtros.</p><p className="text-sm text-muted-foreground">{data.agents.length ? 'Probá ampliar el período o cambiar de agente.' : 'Necesitás acceso por agente para consultar usuarios que todavía no tienen contacto.'}</p></div> :
      <div className="surface overflow-x-auto"><table className="w-full min-w-[640px] text-sm"><thead className="bg-muted/50 text-left"><tr>{['Usuario', 'Agente', 'Plataforma', 'Último movimiento', 'Detectado en el sistema'].map(h => <th key={h} className="p-3 font-medium">{h}</th>)}</tr></thead>
        <tbody>{data.users.map(row => <tr key={`${row.platform}:${row.username}`} className="border-t"><td className="p-3 font-medium">{row.username}</td><td className="p-3">{row.agent}</td><td className="p-3">{row.platform}</td><td className="p-3">{row.last_movement ? date(row.last_movement) : 'Sin movimientos registrados'}</td><td className="p-3">{date(row.first_seen_at)}</td></tr>)}</tbody></table></div>}
      <div className="flex flex-wrap justify-between items-center gap-3 text-sm text-muted-foreground"><p>{data.total.toLocaleString('es-AR')} usuarios pendientes · Página {page} de {Math.max(1, Math.ceil(data.total / 50))}</p><div className="flex gap-2"><Button variant="outline" size="icon" aria-label="Página anterior" disabled={page === 1} onClick={() => setPage(p => p - 1)}><ChevronLeft className="size-4" /></Button><Button variant="outline" size="icon" aria-label="Página siguiente" disabled={page * 50 >= data.total} onClick={() => setPage(p => p + 1)}><ChevronRight className="size-4" /></Button></div></div>
    </>}
    <Dialog open={importOpen} onOpenChange={open => { if (!busy) setImportOpen(open) }}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>{result && !result.dryRun ? 'Carga completada' : 'Revisar celulares'}</DialogTitle></DialogHeader>
      <p className="text-sm text-muted-foreground break-all">{filename}</p>
      {busy && <p role="status">{result ? 'Incorporando contactos…' : 'Revisando el archivo…'}</p>}
      {importError && <p role="alert" className="text-sm text-destructive">{importError}</p>}
      {result && <div className="space-y-4 text-sm">
        <p role="status">{result.dryRun ? `${result.ready} cuentas listas para importar.` : `${result.linked} cuentas incorporadas a Contactos (${result.inserted} contactos nuevos).`}</p>
        <p className="text-muted-foreground">{result.blank} sin celular · {result.unchanged} ya vinculadas o repetidas · {result.errors.length} filas con errores</p>
        <p>Las filas sin celular o con errores seguirán pendientes. Los contactos existentes conservarán sus datos y preferencias.</p>
        {result.errors.length > 0 && <div className="max-h-56 overflow-y-auto rounded-lg border p-3 space-y-2">{result.errors.map((e, index) => <p key={index}><strong>Fila {e.row} · {e.username || '(sin usuario)'}:</strong> {e.error}</p>)}</div>}
        {result.dryRun && result.ready > 0 && <Button disabled={busy} onClick={commit}>Importar {result.ready} cuentas válidas</Button>}
      </div>}
      {!busy && <Button variant="outline" onClick={() => setImportOpen(false)}>Cerrar</Button>}
    </DialogContent></Dialog>
  </div>
}
