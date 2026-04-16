'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  RefreshCw, Plus, Flame, Pause, Play, Trash2, FileText,
  QrCode, CheckCircle, Loader2, AlertCircle, ExternalLink, KeyRound,
  ArrowRight, Pencil, Wifi, WifiOff,
} from 'lucide-react'

interface WarmupNumber {
  id: string
  phone_number: string
  instance_name: string
  display_name: string | null
  warmup_status: 'active' | 'paused' | 'completed' | 'banned'
  current_day: number
  target_days: number
  messages_sent_today: number
  daily_limit: number
  last_message_at: string | null
  notes: string | null
}

interface LogEntry {
  id: string; recipient: string; message_type: string
  message_preview: string; status: string; warmup_day: number; sent_at: string
}

type QrState = 'idle' | 'loading' | 'not-found' | 'creating' | 'qr' | 'connected' | 'error'

const EVO_MANAGER = 'https://evolution-api-production-ec6b.up.railway.app/manager'

const STATUS_COLORS: Record<string, string> = {
  active:    'bg-green-100 text-green-700',
  paused:    'bg-yellow-100 text-yellow-700',
  completed: 'bg-blue-100 text-blue-700',
  banned:    'bg-red-100 text-red-700',
}
const STATUS_LABELS: Record<string, string> = {
  active: 'Activo', paused: 'Pausado', completed: 'Completado', banned: 'Baneado',
}

export default function WarmupPage() {
  const [numbers, setNumbers] = useState<WarmupNumber[]>([])
  const [loading, setLoading] = useState(false)

  // Add modal
  const [showAdd, setShowAdd]         = useState(false)
  const [addName, setAddName]         = useState('')
  const [addPhone, setAddPhone]       = useState('')
  const [addInstance, setAddInstance] = useState('')
  const [addDays, setAddDays]         = useState('14')
  const [addLimit, setAddLimit]       = useState('10')
  const [addSaving, setAddSaving]     = useState(false)
  const [addError, setAddError]       = useState('')

  // Inline name edit
  const [editingId, setEditingId]     = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  // Logs modal
  const [logsFor, setLogsFor]         = useState<WarmupNumber | null>(null)
  const [logs, setLogs]               = useState<LogEntry[]>([])
  const [logsLoading, setLogsLoading] = useState(false)

  // Migrate confirm
  const [migratingId, setMigratingId]   = useState<string | null>(null)
  const [migrateError, setMigrateError] = useState('')

  // QR modal
  const [qrFor, setQrFor]         = useState<WarmupNumber | null>(null)
  const [qrState, setQrState]     = useState<QrState>('idle')
  const [qrBase64, setQrBase64]   = useState<string | null>(null)
  const [qrError, setQrError]     = useState<string | null>(null)
  const [globalKey, setGlobalKey] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const d = await fetch('/api/warmup').then(r => r.json()).catch(() => ({ numbers: [] }))
    setNumbers(d.numbers || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const openAdd = () => {
    setShowAdd(true); setAddError('')
    setAddName(''); setAddPhone(''); setAddInstance('')
    setAddDays('14'); setAddLimit('10')
  }

  // ── Stats ─────────────────────────────────────────────────
  const active    = numbers.filter(n => n.warmup_status === 'active').length
  const paused    = numbers.filter(n => n.warmup_status === 'paused').length
  const completed = numbers.filter(n => n.warmup_status === 'completed').length
  const banned    = numbers.filter(n => n.warmup_status === 'banned').length

  // ── CRUD ──────────────────────────────────────────────────
  const addNumber = async (openQrAfter = false) => {
    if (!addPhone.trim() || !addInstance.trim()) { setAddError('Teléfono e instancia son requeridos'); return }
    setAddSaving(true); setAddError('')
    const res = await fetch('/api/warmup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone_number: addPhone.trim(),
        instance_name: addInstance.trim(),
        display_name: addName.trim() || undefined,
        target_days: Number(addDays) || 14,
        daily_limit: Number(addLimit) || 10,
      }),
    })
    setAddSaving(false)
    if (!res.ok) { const d = await res.json(); setAddError(d.error || 'Error al agregar'); return }

    const savedInstance = addInstance.trim()
    const savedPhone    = addPhone.trim()
    const savedName     = addName.trim()
    setShowAdd(false)
    await load()

    if (openQrAfter) {
      // Open QR modal for the newly added line
      const newEntry: WarmupNumber = {
        id: '', phone_number: savedPhone, instance_name: savedInstance,
        display_name: savedName || null, warmup_status: 'active',
        current_day: 1, target_days: Number(addDays) || 14,
        messages_sent_today: 0, daily_limit: Number(addLimit) || 10,
        last_message_at: null, notes: null,
      }
      openQr(newEntry)
    }
  }

  const saveName = async (id: string) => {
    await fetch(`/api/warmup/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: editingName.trim() || null }),
    })
    setEditingId(null); load()
  }

  const toggleStatus = async (n: WarmupNumber) => {
    const next = n.warmup_status === 'active' ? 'paused' : 'active'
    await fetch(`/api/warmup/${n.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ warmup_status: next }),
    })
    load()
  }

  const deleteNumber = async (id: string) => {
    if (!confirm('¿Eliminar esta línea del calentamiento?')) return
    await fetch(`/api/warmup/${id}`, { method: 'DELETE' })
    load()
  }

  const openLogs = async (n: WarmupNumber) => {
    setLogsFor(n); setLogsLoading(true)
    const d = await fetch(`/api/warmup/${n.id}/logs`).then(r => r.json())
    setLogs(d.logs || []); setLogsLoading(false)
  }

  const migrate = async () => {
    if (!migratingId) return
    setMigrateError('')
    const res = await fetch(`/api/warmup/${migratingId}/migrate`, { method: 'POST' })
    if (!res.ok) { const d = await res.json(); setMigrateError(d.error || 'Error al migrar'); return }
    setMigratingId(null); load()
  }

  // ── QR ────────────────────────────────────────────────────
  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }

  const closeQr = () => {
    stopPoll(); setQrFor(null); setQrState('idle')
    setQrBase64(null); setQrError(null); setGlobalKey('')
  }

  const fetchQr = useCallback(async (instance: string): Promise<boolean> => {
    try {
      const res  = await fetch(`/api/lines/qr?instance=${encodeURIComponent(instance)}`)
      const data = await res.json()
      if (data.connected) { setQrState('connected'); stopPoll(); load(); return true }
      if (data.notFound)  { setQrState('not-found'); stopPoll(); return false }
      if (data.base64)    { setQrBase64(data.base64); setQrState('qr'); return false }
      setQrError(data.error || 'No se pudo obtener el QR'); setQrState('error'); stopPoll(); return false
    } catch { setQrError('Error de conexión'); setQrState('error'); stopPoll(); return false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  const openQr = async (n: WarmupNumber) => {
    setQrFor(n); setQrState('loading'); setQrBase64(null); setQrError(null)
    const done = await fetchQr(n.instance_name)
    if (!done) { stopPoll(); pollRef.current = setInterval(() => fetchQr(n.instance_name), 5000) }
  }

  const createInstance = async () => {
    if (!qrFor) return
    setQrState('creating'); setQrError(null)
    try {
      const res  = await fetch('/api/lines/qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance: qrFor.instance_name, globalKey: globalKey || undefined }),
      })
      const data = await res.json()
      if (res.status === 401) { setQrState('not-found'); setQrError('Global API Key sin permisos.'); return }
      if (data.base64) {
        setQrBase64(data.base64); setQrState('qr'); stopPoll()
        pollRef.current = setInterval(() => fetchQr(qrFor.instance_name), 5000)
      } else { setQrError('Sin QR. Intentá "Obtener QR".'); setQrState('not-found') }
    } catch { setQrError('Error al crear la instancia'); setQrState('not-found') }
  }

  const migratingNumber = numbers.find(n => n.id === migratingId)

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Flame size={20} className="text-orange-500" /> Calentamiento de Líneas
          </h1>
          <p className="text-sm text-gray-500">
            {active} activas · {completed} completadas · {numbers.length} total
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </Button>
          <Button size="sm" className="bg-orange-500 hover:bg-orange-600" onClick={openAdd}>
            <Plus size={14} className="mr-1" /> Agregar línea
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        <Card><CardContent className="pt-4">
          <p className="text-xs text-gray-500 mb-1">Activas</p>
          <p className="text-2xl font-bold text-green-600">{active}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <p className="text-xs text-gray-500 mb-1">Pausadas</p>
          <p className="text-2xl font-bold text-yellow-500">{paused}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <p className="text-xs text-gray-500 mb-1">Completadas</p>
          <p className="text-2xl font-bold text-blue-600">{completed}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <p className="text-xs text-gray-500 mb-1">Baneadas</p>
          <p className="text-2xl font-bold text-red-500">{banned}</p>
        </CardContent></Card>
      </div>

      {/* Tabla */}
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-gray-600">Línea</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Instancia</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Estado</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Progreso</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Hoy</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Total enviados</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Acción</th>
              </tr>
            </thead>
            <tbody>
              {numbers.length === 0
                ? <tr><td colSpan={7}>
                    {loading
                      ? <p className="text-center py-12 text-gray-400">Cargando…</p>
                      : <div className="flex flex-col items-center gap-4 py-16">
                          <div className="w-14 h-14 bg-orange-50 rounded-full flex items-center justify-center">
                            <Flame size={28} className="text-orange-400" />
                          </div>
                          <div className="text-center">
                            <p className="font-medium text-gray-700 mb-1">Sin líneas en calentamiento</p>
                            <p className="text-sm text-gray-400">Agregá una línea nueva para comenzar el proceso de calentamiento y vincularla por QR.</p>
                          </div>
                          <Button className="bg-orange-500 hover:bg-orange-600" onClick={openAdd}>
                            <Plus size={14} className="mr-2" /> Agregar primera línea
                          </Button>
                        </div>
                    }
                  </td></tr>
                : numbers.map(n => {
                    const dayPct = n.target_days ? (n.current_day / n.target_days) * 100 : 0
                    const msgPct = n.daily_limit  ? (n.messages_sent_today / n.daily_limit) * 100 : 0
                    const isComplete = n.warmup_status === 'completed'
                    const label = n.display_name || n.instance_name
                    const isEditing = editingId === n.id

                    return (
                      <tr key={n.id} className={`border-b border-gray-100 hover:bg-gray-50 ${isComplete ? 'bg-blue-50/30' : ''}`}>
                        {/* Nombre editable */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {n.warmup_status === 'active'
                              ? <Wifi size={14} className="text-orange-400 flex-shrink-0" />
                              : <WifiOff size={14} className="text-gray-300 flex-shrink-0" />
                            }
                            {isEditing
                              ? <form onSubmit={e => { e.preventDefault(); saveName(n.id) }} className="flex items-center gap-1">
                                  <Input
                                    autoFocus
                                    value={editingName}
                                    onChange={e => setEditingName(e.target.value)}
                                    onBlur={() => saveName(n.id)}
                                    onKeyDown={e => e.key === 'Escape' && setEditingId(null)}
                                    className="h-7 text-xs w-36"
                                  />
                                </form>
                              : <div className="flex items-center gap-1 group">
                                  <span className="font-medium">{label}</span>
                                  <button
                                    onClick={() => { setEditingId(n.id); setEditingName(n.display_name || n.instance_name) }}
                                    className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-gray-600"
                                  >
                                    <Pencil size={12} />
                                  </button>
                                </div>
                            }
                          </div>
                        </td>

                        <td className="px-4 py-3 font-mono text-xs text-gray-500">{n.instance_name}</td>

                        <td className="px-4 py-3">
                          <Badge className={`text-xs ${STATUS_COLORS[n.warmup_status] || ''}`}>
                            {STATUS_LABELS[n.warmup_status] || n.warmup_status}
                          </Badge>
                        </td>

                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-20 bg-gray-100 rounded-full h-1.5">
                              <div className={`h-1.5 rounded-full ${isComplete ? 'bg-blue-400' : 'bg-orange-400'}`}
                                style={{ width: `${Math.min(dayPct, 100)}%` }} />
                            </div>
                            <span className="text-xs text-gray-500">Día {n.current_day}/{n.target_days}</span>
                          </div>
                        </td>

                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-16 bg-gray-100 rounded-full h-1.5">
                              <div className="bg-green-400 h-1.5 rounded-full" style={{ width: `${Math.min(msgPct, 100)}%` }} />
                            </div>
                            <span className="text-xs text-gray-500">{n.messages_sent_today}/{n.daily_limit}</span>
                          </div>
                        </td>

                        <td className="px-4 py-3 text-gray-500 text-sm">—</td>

                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            {/* QR siempre visible */}
                            <Button size="sm" variant="outline"
                              className="text-xs border-orange-200 text-orange-700 hover:bg-orange-50 h-7 px-2"
                              onClick={() => openQr(n)}>
                              <QrCode size={12} className="mr-1" /> Vincular QR
                            </Button>

                            {/* Logs */}
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-gray-400"
                              title="Actividad" onClick={() => openLogs(n)}>
                              <FileText size={13} />
                            </Button>

                            {/* Pausa / reanudar */}
                            {(n.warmup_status === 'active' || n.warmup_status === 'paused') && (
                              <Button size="sm" variant="ghost"
                                className={`h-7 w-7 p-0 ${n.warmup_status === 'active' ? 'text-yellow-500' : 'text-green-600'}`}
                                title={n.warmup_status === 'active' ? 'Pausar' : 'Reanudar'}
                                onClick={() => toggleStatus(n)}>
                                {n.warmup_status === 'active' ? <Pause size={13} /> : <Play size={13} />}
                              </Button>
                            )}

                            {/* Migrar — solo completados */}
                            {isComplete && (
                              <Button size="sm" variant="outline"
                                className="h-7 px-2 text-xs border-blue-200 text-blue-700 hover:bg-blue-50"
                                onClick={() => { setMigratingId(n.id); setMigrateError('') }}>
                                <ArrowRight size={12} className="mr-1" /> Mover a Difusión
                              </Button>
                            )}

                            {/* Eliminar */}
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-400 hover:text-red-600"
                              title="Eliminar" onClick={() => deleteNumber(n.id)}>
                              <Trash2 size={13} />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })
              }
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* ── Modal agregar ── */}
      <Dialog open={showAdd} onOpenChange={open => { if (!open) setShowAdd(false) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Flame size={16} className="text-orange-500" /> Agregar línea al calentamiento
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-1">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Nombre para mostrar</label>
              <Input placeholder="Ej: Línea Betcoin 01" value={addName} onChange={e => setAddName(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Número de teléfono *</label>
              <Input
                placeholder="5492235042625"
                value={addPhone}
                onChange={e => {
                  const val = e.target.value.replace(/\D/g, '')
                  setAddPhone(val)
                  // Auto-generate instance name
                  if (val) setAddInstance(`warmup-${val}`)
                  else setAddInstance('')
                }}
                className="font-mono text-sm"
              />
              {addInstance && (
                <p className="text-xs text-gray-400 mt-1">
                  Instancia: <span className="font-mono text-gray-600">{addInstance}</span>
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Días objetivo</label>
                <Input type="number" min={1} max={60} value={addDays} onChange={e => setAddDays(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Límite diario</label>
                <Input type="number" min={1} max={100} value={addLimit} onChange={e => setAddLimit(e.target.value)} />
              </div>
            </div>
            {addError && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{addError}</p>}
            <div className="flex flex-col gap-2 pt-1">
              <Button className="w-full bg-orange-500 hover:bg-orange-600"
                onClick={() => addNumber(true)} disabled={addSaving || !addPhone}>
                <QrCode size={14} className="mr-2" />
                {addSaving ? 'Guardando…' : 'Agregar y vincular QR'}
              </Button>
              <Button variant="outline" className="w-full"
                onClick={() => addNumber(false)} disabled={addSaving || !addPhone}>
                {addSaving ? 'Guardando…' : 'Solo agregar (vincular QR después)'}
              </Button>
              <Button variant="ghost" className="w-full text-gray-500" onClick={() => setShowAdd(false)}>Cancelar</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Modal migración ── */}
      <Dialog open={!!migratingId} onOpenChange={open => { if (!open) { setMigratingId(null); setMigrateError('') } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRight size={16} className="text-blue-600" /> Mover a Difusión
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-1">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm">
              <p className="font-medium text-blue-800 mb-1">¿Confirmar migración?</p>
              <p className="text-blue-600 text-xs">
                La línea <code className="bg-blue-100 px-1 rounded font-mono">{migratingNumber?.display_name || migratingNumber?.instance_name}</code> se
                agregará al módulo de <strong>Difusión</strong> y quedará disponible para campañas.
              </p>
            </div>
            {migrateError && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{migrateError}</p>}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setMigratingId(null)}>Cancelar</Button>
              <Button className="flex-1 bg-blue-600 hover:bg-blue-700" onClick={migrate}>Confirmar migración</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Modal QR ── */}
      <Dialog open={!!qrFor} onOpenChange={open => { if (!open) closeQr() }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <QrCode size={16} /> Vincular {qrFor?.display_name || qrFor?.instance_name}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-2">

            {qrState === 'loading' && (
              <div className="flex flex-col items-center gap-3 py-8">
                <Loader2 size={32} className="animate-spin text-gray-400" />
                <p className="text-sm text-gray-500">Verificando instancia…</p>
              </div>
            )}

            {qrState === 'creating' && (
              <div className="flex flex-col items-center gap-3 py-8">
                <Loader2 size={32} className="animate-spin text-orange-500" />
                <p className="text-sm text-gray-600">Creando instancia en Evolution…</p>
              </div>
            )}

            {qrState === 'not-found' && (
              <div className="w-full space-y-4">
                <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 text-sm">
                  <p className="font-medium text-orange-800 mb-1">Instancia no registrada en Evolution</p>
                  <p className="text-orange-600 text-xs">
                    <code className="bg-orange-100 px-1 rounded font-mono">{qrFor?.instance_name}</code> no existe todavía.
                  </p>
                </div>
                {qrError && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-3">{qrError}</p>}
                <div className="border rounded-lg p-4 space-y-3">
                  <p className="text-xs font-medium text-gray-700 flex items-center gap-1.5">
                    <KeyRound size={13} /> Crear instancia automáticamente
                  </p>
                  <Input placeholder="Global API Key de Evolution" value={globalKey}
                    onChange={e => setGlobalKey(e.target.value)} className="text-xs font-mono" />
                  <Button className="w-full bg-orange-500 hover:bg-orange-600 text-sm"
                    onClick={createInstance} disabled={!globalKey}>
                    Crear instancia y obtener QR
                  </Button>
                </div>
                <div className="border rounded-lg p-4 space-y-2">
                  <p className="text-xs font-medium text-gray-700">O creala manualmente en Evolution</p>
                  <div className="flex gap-2">
                    <a href={EVO_MANAGER} target="_blank" rel="noreferrer" className="flex-1">
                      <Button variant="outline" size="sm" className="w-full text-xs">
                        <ExternalLink size={12} className="mr-1" /> Evolution Manager
                      </Button>
                    </a>
                    <Button size="sm" variant="outline" className="flex-1 text-xs"
                      onClick={() => { setQrState('loading'); fetchQr(qrFor!.instance_name) }}>
                      <RefreshCw size={12} className="mr-1" /> Obtener QR
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {qrState === 'qr' && qrBase64 && (
              <>
                <div className="border-4 border-gray-200 rounded-xl p-2 bg-white">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qrBase64.startsWith('data:') ? qrBase64 : `data:image/png;base64,${qrBase64}`}
                    alt="QR WhatsApp" className="w-56 h-56 object-contain" />
                </div>
                <div className="text-center space-y-1">
                  <p className="text-sm font-medium">Escaneá con WhatsApp</p>
                  <p className="text-xs text-gray-400">WhatsApp → Dispositivos vinculados → Vincular un dispositivo</p>
                  <p className="text-xs text-orange-500 flex items-center justify-center gap-1 mt-2">
                    <Loader2 size={11} className="animate-spin" /> Esperando escaneo…
                  </p>
                </div>
                <Button variant="outline" size="sm" className="w-full"
                  onClick={() => { setQrState('loading'); fetchQr(qrFor!.instance_name) }}>
                  <RefreshCw size={13} className="mr-1" /> Regenerar QR
                </Button>
              </>
            )}

            {qrState === 'connected' && (
              <div className="flex flex-col items-center gap-3 py-6">
                <CheckCircle size={48} className="text-green-500" />
                <p className="text-base font-semibold text-green-700">¡Línea conectada!</p>
                <p className="text-sm text-gray-500 text-center">
                  {qrFor?.display_name || qrFor?.instance_name} está lista para el calentamiento.
                </p>
                <Button className="w-full bg-orange-500 hover:bg-orange-600" onClick={closeQr}>Cerrar</Button>
              </div>
            )}

            {qrState === 'error' && (
              <div className="flex flex-col items-center gap-3 py-6">
                <AlertCircle size={40} className="text-red-400" />
                <p className="text-sm text-red-600 text-center">{qrError}</p>
                <Button variant="outline" size="sm"
                  onClick={() => { setQrState('loading'); fetchQr(qrFor!.instance_name) }}>Reintentar</Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Modal logs ── */}
      <Dialog open={!!logsFor} onOpenChange={open => { if (!open) setLogsFor(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText size={16} /> Actividad — {logsFor?.display_name || logsFor?.phone_number}
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-96 overflow-y-auto">
            {logsLoading
              ? <p className="text-center text-gray-400 py-8">Cargando…</p>
              : logs.length === 0
                ? <p className="text-center text-gray-400 py-8">Sin actividad registrada aún</p>
                : <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50">
                        <th className="text-left px-3 py-2 font-medium text-gray-600">Destinatario</th>
                        <th className="text-left px-3 py-2 font-medium text-gray-600">Tipo</th>
                        <th className="text-left px-3 py-2 font-medium text-gray-600">Mensaje</th>
                        <th className="text-left px-3 py-2 font-medium text-gray-600">Estado</th>
                        <th className="text-left px-3 py-2 font-medium text-gray-600">Día</th>
                        <th className="text-left px-3 py-2 font-medium text-gray-600">Hora</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map(l => (
                        <tr key={l.id} className="border-b border-gray-100 hover:bg-gray-50">
                          <td className="px-3 py-2 font-mono">{l.recipient}</td>
                          <td className="px-3 py-2 text-gray-500">{l.message_type}</td>
                          <td className="px-3 py-2 text-gray-700 max-w-xs truncate">{l.message_preview}</td>
                          <td className="px-3 py-2">
                            <Badge className={`text-xs ${l.status === 'sent' ? 'bg-green-100 text-green-700' : l.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
                              {l.status}
                            </Badge>
                          </td>
                          <td className="px-3 py-2 text-gray-500">{l.warmup_day}</td>
                          <td className="px-3 py-2 text-gray-400">
                            {new Date(l.sent_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
            }
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
