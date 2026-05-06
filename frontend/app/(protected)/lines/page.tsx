'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RefreshCw, Wifi, WifiOff, QrCode, CheckCircle, Loader2, AlertCircle, ExternalLink, ShieldCheck, ShieldOff, LogOut, Plus, RotateCcw } from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'
import { useCurrentUser } from '@/lib/useCurrentUser'

interface Line {
  id: string; line_key: string; display_name: string; phone_number: string
  evolution_instance: string; status: string; is_connected: boolean
  sending_enabled: boolean; eligible: boolean
  msgs_sent_today: number; msgs_sent_hour: number
  msg_per_day: number; msg_per_hour: number
  total_sent: number; total_failed: number
  priority: number; last_seen_at: string
}

// connecting = QR escaneado, handshake en curso — NO regenerar QR en este estado
type QrState = 'idle' | 'loading' | 'not-found' | 'creating' | 'qr' | 'connecting' | 'connected' | 'error'

const EVO_MANAGER  = process.env.NEXT_PUBLIC_EVOLUTION_MANAGER_URL ?? ''

function ineligibilityReason(l: Line): string | null {
  if (l.eligible) return null
  if (l.status !== 'active')    return 'Línea inactiva'
  if (!l.is_connected)          return 'Desconectada'
  if (!l.sending_enabled)       return 'Envíos desactivados'
  if (l.msgs_sent_hour >= l.msg_per_hour) return 'Límite horario agotado'
  if (l.msgs_sent_today >= l.msg_per_day) return 'Límite diario agotado'
  return 'No elegible'
}
const QR_TTL_MS    = 60_000   // WhatsApp QR expira en ~60s
const STATUS_INTERVAL_MS = 3_000  // polling de estado post-scan

export default function Lines() {
  const { user } = useCurrentUser()
  const isAdmin = user?.role === 'admin'

  const [lines, setLines]         = useState<Line[]>([])
  const [loading, setLoading]     = useState(false)
  const [toggling, setToggling]   = useState<string | null>(null)
  const [syncing, setSyncing]     = useState<string | null>(null)

  // QR modal
  const [qrLine, setQrLine]           = useState<Line | null>(null)
  const [qrState, setQrState]         = useState<QrState>('idle')
  const [qrBase64, setQrBase64]       = useState<string | null>(null)
  const [qrError, setQrError]         = useState<string | null>(null)
  const [canCreate, setCanCreate]     = useState(false)
  const [qrExpiresAt, setQrExpiresAt] = useState<number | null>(null)
  const [timeLeft, setTimeLeft]       = useState(60)

  // pollRef apunta siempre al polling de ESTADO (/qr/status), nunca al de generación
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Unlink modal
  const [unlinkTarget, setUnlinkTarget]   = useState<Line | null>(null)
  const [unlinkLoading, setUnlinkLoading] = useState(false)
  const [unlinkError, setUnlinkError]     = useState<string | null>(null)

  // Add existing line modal
  const [addOpen, setAddOpen]               = useState(false)
  const [addInstance, setAddInstance]       = useState('')
  const [addDisplayName, setAddDisplayName] = useState('')
  const [addPhone, setAddPhone]             = useState('')
  const [addLoading, setAddLoading]         = useState(false)
  const [addError, setAddError]             = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    fetchJson<{ lines: Line[] }>('/api/lines')
      .then(d => setLines(d.lines || []))
      .catch(() => setLines([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  // Countdown del QR — al llegar a 0 solo actualiza la UI.
  // NO detiene el poll: el usuario puede haber escaneado en los últimos segundos
  // y el handshake (connecting→open) puede tardar unos segundos más.
  useEffect(() => {
    if (qrState !== 'qr' || !qrExpiresAt) return
    const tick = setInterval(() => {
      const left = Math.max(0, Math.ceil((qrExpiresAt - Date.now()) / 1000))
      setTimeLeft(left)
      if (left === 0) clearInterval(tick)
    }, 1000)
    return () => clearInterval(tick)
  }, [qrState, qrExpiresAt])

  const toggleSending = async (line: Line) => {
    setToggling(line.id)
    try {
      await fetch('/api/lines', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: line.id, sending_enabled: !line.sending_enabled }),
      })
      load()
    } catch { /* ignore */ } finally {
      setToggling(null)
    }
  }

  // Consulta el estado real de Evolution para una línea y actualiza la DB si está conectada.
  // Útil cuando el QR fue escaneado pero el sistema no lo detectó (race condition o webhook fallido).
  const syncStatus = async (line: Line) => {
    setSyncing(line.id)
    try {
      const res  = await fetch(`/api/lines/qr/status?instance=${encodeURIComponent(line.evolution_instance)}`)
      const data = await res.json()
      if (data.connected || data.state === 'open') load()
      else load() // reload anyway to show current state
    } catch { /* ignore */ } finally {
      setSyncing(null)
    }
  }

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  const closeQr = () => {
    stopPoll()
    setQrLine(null); setQrState('idle'); setQrBase64(null)
    setQrError(null); setCanCreate(false); setQrExpiresAt(null)
  }

  // ── pollStatus ──────────────────────────────────────────────────────────────
  // Consulta /qr/status (usa fetchInstances — read-only, NO regenera QR).
  // Es la ÚNICA función que corre en el intervalo después de mostrar el QR.
  const pollStatus = useCallback(async (instance: string): Promise<void> => {
    try {
      const res  = await fetch(`/api/lines/qr/status?instance=${encodeURIComponent(instance)}`)
      const data = await res.json()

      if (data.connected) {
        setQrState('connected'); stopPoll(); load(); return
      }
      if (data.notFound) {
        // La instancia desapareció de Evolution durante el polling
        stopPoll(); setCanCreate(data.canCreate ?? false); setQrState('not-found'); return
      }
      if (data.state === 'connecting') {
        setQrState('connecting'); return
      }
      // state === 'close' → esperando scan, no hacer nada
    } catch {
      // error transitorio de red — ignorar, seguir polling
    }
  }, [load])

  // ── fetchQr ─────────────────────────────────────────────────────────────────
  // Genera / obtiene un QR nuevo desde Evolution.
  // Llamar SOLO para (re)generar — no en el intervalo de polling.
  const fetchQr = useCallback(async (instance: string, restart = false): Promise<boolean> => {
    try {
      const url  = `/api/lines/qr?instance=${encodeURIComponent(instance)}${restart ? '&restart=true' : ''}`
      const res  = await fetch(url)
      const data = await res.json()

      // La instancia ya estaba conectada — no hacía falta regenerar
      if (data.connected || data.alreadyConnected) {
        setQrState('connected'); stopPoll(); load(); return true
      }
      if (data.notFound) {
        setCanCreate(data.canCreate ?? false)
        setQrState('not-found'); stopPoll(); return false
      }
      // Evolution respondió "connecting" sin QR — handshake ya en curso
      if (data.state === 'connecting') {
        setQrState('connecting')
        return false
      }
      if (data.base64) {
        setQrBase64(data.base64)
        setQrState('qr')
        setQrExpiresAt(Date.now() + QR_TTL_MS)
        setTimeLeft(60)
        return false
      }
      setQrError(data.error || 'No se pudo obtener el QR')
      setQrState('error')
      stopPoll()
      return false
    } catch {
      setQrError('Error de conexión')
      setQrState('error')
      stopPoll()
      return false
    }
  }, [load])

  // ── openQrModal ─────────────────────────────────────────────────────────────
  // Siempre usa restart=true para limpiar sesiones Baileys previas antes de
  // generar el QR. Sin esto, Evolution intenta reusar credenciales expiradas
  // y WhatsApp rechaza el handshake con "no se pudo vincular el dispositivo".
  const openQrModal = async (line: Line) => {
    setQrLine(line); setQrState('loading'); setQrBase64(null)
    setQrError(null); setQrExpiresAt(null)

    const done = await fetchQr(line.evolution_instance, true)
    if (!done) {
      stopPoll()
      pollRef.current = setInterval(() => pollStatus(line.evolution_instance), STATUS_INTERVAL_MS)
    }
  }

  // ── handleRegenerate ────────────────────────────────────────────────────────
  // Para el polling de estado, hace restart + genera QR nuevo, reanuda polling.
  const handleRegenerate = () => {
    if (!qrLine) return
    stopPoll()
    setQrState('loading')
    setQrBase64(null)
    fetchQr(qrLine.evolution_instance, true).then(done => {
      if (!done) {
        pollRef.current = setInterval(() => pollStatus(qrLine.evolution_instance), STATUS_INTERVAL_MS)
      }
    })
  }

  // ── createInstance ──────────────────────────────────────────────────────────
  const createInstance = async () => {
    if (!qrLine) return
    setQrState('creating'); setQrError(null)
    try {
      const res  = await fetch('/api/lines/qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance: qrLine.evolution_instance }),
      })
      const data = await res.json()

      if (res.status === 401) {
        setQrState('not-found')
        setQrError('Sin permisos para crear instancias. Creala manualmente en el panel de Evolution.')
        return
      }
      if (res.status === 500 && data?.error === 'Evolution admin key not configured') {
        setQrState('not-found')
        setQrError('El Global API Key de Evolution no está configurado en el servidor.')
        return
      }
      if (data.base64) {
        setQrBase64(data.base64)
        setQrState('qr')
        setQrExpiresAt(Date.now() + QR_TTL_MS)
        setTimeLeft(60)
        stopPoll()
        // Polling de estado, no de QR
        pollRef.current = setInterval(() => pollStatus(qrLine.evolution_instance), STATUS_INTERVAL_MS)
      } else {
        setQrError('Instancia creada pero no se pudo obtener el QR. Intentá "Obtener QR" de nuevo.')
        setQrState('not-found')
      }
    } catch {
      setQrError('Error al crear la instancia'); setQrState('not-found')
    }
  }

  const confirmUnlink = async () => {
    if (!unlinkTarget) return
    setUnlinkLoading(true)
    setUnlinkError(null)
    try {
      const res  = await fetch(`/api/lines/qr?instance=${encodeURIComponent(unlinkTarget.evolution_instance)}`, {
        method: 'DELETE',
      })
      const data = await res.json()
      if (!res.ok) { setUnlinkError(data.error || 'Error al desvincular'); return }
      setUnlinkTarget(null)
      load()
    } catch {
      setUnlinkError('Error de conexión')
    } finally {
      setUnlinkLoading(false)
    }
  }

  useEffect(() => () => stopPoll(), [])

  const addLine = async () => {
    if (!addInstance.trim()) return
    setAddLoading(true); setAddError(null)
    try {
      const res = await fetch('/api/lines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          evolution_instance: addInstance.trim(),
          display_name:       addDisplayName.trim() || undefined,
          phone_number:       addPhone.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) { setAddError(data.error || 'Error al agregar'); return }
      setAddOpen(false); setAddInstance(''); setAddDisplayName(''); setAddPhone('')
      load()
    } catch {
      setAddError('Error de conexión')
    } finally {
      setAddLoading(false)
    }
  }

  const connected = lines.filter(l => l.is_connected).length
  const active    = lines.filter(l => l.status === 'active').length
  const eligible  = lines.filter(l => l.eligible).length

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Líneas WhatsApp</h1>
          <p className="text-sm text-gray-500">
            {connected} conectadas · {active} activas · {eligible} elegibles · {lines.length} total
          </p>
        </div>
        <div className="flex gap-2">
          {isAdmin && (
            <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-white"
              onClick={() => { setAddOpen(true); setAddError(null) }}>
              <Plus size={14} className="mr-1" /> Agregar línea
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </Button>
        </div>
      </div>

      {/* Resumen */}
      <div className="grid grid-cols-4 gap-4">
        <Card><CardContent className="pt-4">
          <p className="text-xs text-gray-500 mb-1">Conectadas</p>
          <p className="text-2xl font-bold text-green-600">{connected}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <p className="text-xs text-gray-500 mb-1">Elegibles campañas</p>
          <p className="text-2xl font-bold text-indigo-600">{eligible}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <p className="text-xs text-gray-500 mb-1">Total enviados hoy</p>
          <p className="text-2xl font-bold">{lines.reduce((a, l) => a + l.msgs_sent_today, 0).toLocaleString()}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <p className="text-xs text-gray-500 mb-1">Capacidad diaria</p>
          <p className="text-2xl font-bold">{lines.reduce((a, l) => a + l.msg_per_day, 0).toLocaleString()}</p>
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
                <th className="text-left px-4 py-3 font-medium text-gray-600">Elegible</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Hoy</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Esta hora</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Total enviados</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Envíos</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Acción</th>
                {isAdmin && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody>
              {lines.length === 0
                ? <tr><td colSpan={isAdmin ? 10 : 9} className="text-center py-10 text-gray-400">
                    {loading ? 'Cargando…' : 'Sin líneas configuradas'}
                  </td></tr>
                : lines.map(l => {
                    const pctDay  = l.msg_per_day  ? (l.msgs_sent_today / l.msg_per_day)  * 100 : 0
                    const pctHour = l.msg_per_hour ? (l.msgs_sent_hour  / l.msg_per_hour) * 100 : 0
                    return (
                      <tr key={l.id} className="border-b border-gray-100 hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {l.is_connected
                              ? <Wifi size={14} className="text-green-500" />
                              : <WifiOff size={14} className="text-gray-300" />
                            }
                            <span className="font-medium">{l.display_name || l.line_key}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-500">{l.evolution_instance}</td>
                        <td className="px-4 py-3">
                          <Badge
                            variant={l.status === 'active' && l.is_connected ? 'default' : 'secondary'}
                            className={`text-xs ${l.status === 'active' && l.is_connected ? 'bg-green-100 text-green-700' : ''}`}>
                            {l.is_connected ? l.status : 'desconectada'}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          {l.eligible
                            ? <span className="flex items-center gap-1 text-xs text-green-600"><ShieldCheck size={13}/> Sí</span>
                            : <span
                                className="flex items-center gap-1 text-xs text-red-400"
                                title={ineligibilityReason(l) ?? 'No elegible'}
                              >
                                <ShieldOff size={13}/> {ineligibilityReason(l) ?? 'No'}
                              </span>
                          }
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-20 bg-gray-100 rounded-full h-1.5">
                              <div className="bg-green-500 h-1.5 rounded-full" style={{ width: `${Math.min(pctDay,100)}%` }} />
                            </div>
                            <span className="text-xs text-gray-500">{l.msgs_sent_today}/{l.msg_per_day}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-16 bg-gray-100 rounded-full h-1.5">
                              <div className="bg-blue-400 h-1.5 rounded-full" style={{ width: `${Math.min(pctHour,100)}%` }} />
                            </div>
                            <span className="text-xs text-gray-500">{l.msgs_sent_hour}/{l.msg_per_hour}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-gray-500">{l.total_sent.toLocaleString()}</td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => toggleSending(l)}
                            disabled={toggling === l.id}
                            title={l.sending_enabled ? 'Desactivar envíos de campaña' : 'Activar envíos de campaña'}
                            className={`relative inline-flex w-9 h-5 rounded-full transition-colors focus:outline-none ${
                              l.sending_enabled ? 'bg-green-500' : 'bg-gray-300'
                            } ${toggling === l.id ? 'opacity-50' : ''}`}
                          >
                            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${l.sending_enabled ? 'translate-x-4' : ''}`} />
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          {l.is_connected
                            ? <span className="text-xs text-green-600 flex items-center gap-1">
                                <CheckCircle size={12}/> Conectada
                              </span>
                            : <div className="flex items-center gap-1.5">
                                <Button size="sm" variant="outline"
                                  className="text-xs border-orange-200 text-orange-700 hover:bg-orange-50"
                                  onClick={() => openQrModal(l)}>
                                  <QrCode size={13} className="mr-1" /> Vincular QR
                                </Button>
                                <button
                                  onClick={() => syncStatus(l)}
                                  disabled={syncing === l.id}
                                  title="Verificar estado de conexión en Evolution"
                                  className="p-1.5 rounded text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors disabled:opacity-50"
                                >
                                  <RotateCcw size={13} className={syncing === l.id ? 'animate-spin' : ''} />
                                </button>
                              </div>
                          }
                        </td>
                        {isAdmin && (
                          <td className="px-4 py-3">
                            {l.is_connected && (
                              <button
                                onClick={() => { setUnlinkTarget(l); setUnlinkError(null) }}
                                title="Desvincular línea"
                                className="p-1.5 rounded text-gray-400 hover:text-orange-600 hover:bg-orange-50 transition-colors"
                              >
                                <LogOut size={14} />
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    )
                  })
              }
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* ── Modal desvincular línea ── */}
      <Dialog open={!!unlinkTarget} onOpenChange={open => { if (!open) { setUnlinkTarget(null); setUnlinkError(null) } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-orange-600">
              <LogOut size={16} /> Desvincular línea
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-gray-700">
              ¿Desvincular <span className="font-semibold">{unlinkTarget?.display_name || unlinkTarget?.line_key}</span>?
              Esto cierra la sesión de WhatsApp pero <span className="font-medium">mantiene</span> la línea en el sistema. Podés volver a vincularla con QR.
            </p>
            {unlinkError && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{unlinkError}</p>
            )}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" disabled={unlinkLoading}
                onClick={() => { setUnlinkTarget(null); setUnlinkError(null) }}>
                Cancelar
              </Button>
              <Button className="flex-1 bg-orange-600 hover:bg-orange-700 text-white" disabled={unlinkLoading}
                onClick={confirmUnlink}>
                {unlinkLoading ? <Loader2 size={14} className="animate-spin mr-1" /> : <LogOut size={14} className="mr-1" />}
                Desvincular
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Modal agregar línea existente ── */}
      <Dialog open={addOpen} onOpenChange={open => { if (!open) { setAddOpen(false); setAddError(null) } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus size={16} /> Agregar línea existente
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-xs text-gray-500">
              Registrá una instancia de Evolution que ya existe como línea de producción.
            </p>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">Nombre de instancia <span className="text-red-500">*</span></label>
              <Input placeholder="ej: wa-instance-01" value={addInstance}
                onChange={e => setAddInstance(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addLine()} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">Nombre para mostrar</label>
              <Input placeholder="ej: Línea 01" value={addDisplayName}
                onChange={e => setAddDisplayName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addLine()} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">Teléfono (opcional)</label>
              <Input placeholder="ej: +5491168618237" value={addPhone}
                onChange={e => setAddPhone(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addLine()} />
            </div>
            {addError && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{addError}</p>
            )}
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" disabled={addLoading}
                onClick={() => { setAddOpen(false); setAddError(null) }}>
                Cancelar
              </Button>
              <Button className="flex-1 bg-indigo-600 hover:bg-indigo-700" disabled={addLoading || !addInstance.trim()}
                onClick={addLine}>
                {addLoading ? <Loader2 size={14} className="animate-spin mr-1" /> : <Plus size={14} className="mr-1" />}
                Agregar
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Modal QR ── */}
      <Dialog open={!!qrLine} onOpenChange={open => { if (!open) closeQr() }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <QrCode size={16} /> Vincular {qrLine?.display_name || qrLine?.line_key}
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col items-center gap-4 py-2">

            {/* Cargando */}
            {(qrState === 'loading' || qrState === 'creating') && (
              <div className="flex flex-col items-center gap-3 py-8">
                <Loader2 size={32} className="animate-spin text-gray-400" />
                <p className="text-sm text-gray-500">
                  {qrState === 'creating' ? 'Creando instancia en Evolution…' : 'Verificando instancia…'}
                </p>
              </div>
            )}

            {/* Instancia no existe */}
            {qrState === 'not-found' && (
              <div className="w-full space-y-4">
                <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 text-sm">
                  <p className="font-medium text-orange-800 mb-1">Instancia no registrada en Evolution</p>
                  <p className="text-orange-600 text-xs">
                    La instancia <code className="bg-orange-100 px-1 rounded font-mono">{qrLine?.evolution_instance}</code> no existe todavía en Evolution API.
                  </p>
                </div>
                {qrError && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-3">{qrError}</p>
                )}
                {canCreate && (
                  <div className="border rounded-lg p-4 space-y-3">
                    <p className="text-xs font-medium text-gray-700">Crear instancia automáticamente</p>
                    <Button className="w-full bg-green-600 hover:bg-green-700 text-sm" onClick={createInstance}>
                      Crear instancia y obtener QR
                    </Button>
                  </div>
                )}
                <div className="border rounded-lg p-4 space-y-2">
                  <p className="text-xs font-medium text-gray-700">O creala manualmente en Evolution</p>
                  <ol className="text-xs text-gray-500 space-y-1 list-decimal list-inside">
                    <li>Abrí el panel de Evolution Manager</li>
                    <li>Creá una nueva instancia con el nombre <code className="bg-gray-100 px-1 rounded font-mono">{qrLine?.evolution_instance}</code></li>
                    <li>Volvé aquí y hacé click en "Obtener QR"</li>
                  </ol>
                  <div className="flex gap-2 mt-2">
                    {EVO_MANAGER && (
                      <a href={EVO_MANAGER} target="_blank" rel="noreferrer" className="flex-1">
                        <Button variant="outline" size="sm" className="w-full text-xs">
                          <ExternalLink size={12} className="mr-1" /> Abrir Evolution Manager
                        </Button>
                      </a>
                    )}
                    <Button size="sm" variant="outline" className="flex-1 text-xs"
                      onClick={() => { setQrState('loading'); fetchQr(qrLine!.evolution_instance) }}>
                      <RefreshCw size={12} className="mr-1" /> Obtener QR
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* QR listo para escanear */}
            {qrState === 'qr' && qrBase64 && (
              <>
                <div className="border-4 border-gray-200 rounded-xl p-2 bg-white">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={qrBase64.startsWith('data:') ? qrBase64 : `data:image/png;base64,${qrBase64}`}
                    alt="QR WhatsApp"
                    className="w-56 h-56 object-contain"
                  />
                </div>
                <div className="text-center space-y-1">
                  <p className="text-sm font-medium">Escaneá con WhatsApp</p>
                  <p className="text-xs text-gray-400">WhatsApp → Dispositivos vinculados → Vincular un dispositivo</p>
                  {timeLeft > 10
                    ? <p className="text-xs text-orange-500 flex items-center justify-center gap-1 mt-1">
                        <Loader2 size={11} className="animate-spin" />
                        Escaneá ahora · expira en {timeLeft}s
                      </p>
                    : timeLeft > 0
                    ? <p className="text-xs text-red-500 font-semibold flex items-center justify-center gap-1 mt-1">
                        <Loader2 size={11} className="animate-spin" />
                        Apurate — expira en {timeLeft}s
                      </p>
                    : <p className="text-xs text-red-500 font-medium mt-1">
                        QR expirado · hacé clic en Regenerar para obtener uno nuevo
                      </p>
                  }
                </div>
                <Button
                  variant="outline" size="sm" className="w-full"
                  disabled={timeLeft > 0 && timeLeft <= 3}
                  onClick={handleRegenerate}
                >
                  <RefreshCw size={13} className="mr-1" />
                  {timeLeft === 0 ? 'Obtener nuevo QR' : 'Regenerar QR'}
                </Button>
              </>
            )}

            {/* QR escaneado — handshake en curso */}
            {qrState === 'connecting' && (
              <div className="flex flex-col items-center gap-3 py-8">
                <Loader2 size={36} className="animate-spin text-blue-500" />
                <p className="text-sm font-semibold text-blue-700">Vinculando dispositivo…</p>
                <p className="text-xs text-gray-500 text-center">
                  Confirmá en tu teléfono si WhatsApp lo solicita.<br />
                  No cierres esta ventana ni regeneres el QR.
                </p>
              </div>
            )}

            {/* Conectada */}
            {qrState === 'connected' && (
              <div className="flex flex-col items-center gap-3 py-6">
                <CheckCircle size={48} className="text-green-500" />
                <p className="text-base font-semibold text-green-700">¡Línea conectada!</p>
                <p className="text-sm text-gray-500 text-center">
                  {qrLine?.display_name} está lista para enviar mensajes.
                </p>
                <Button className="w-full bg-green-600 hover:bg-green-700" onClick={closeQr}>Cerrar</Button>
              </div>
            )}

            {/* Error genérico */}
            {qrState === 'error' && (
              <div className="flex flex-col items-center gap-3 py-6">
                <AlertCircle size={40} className="text-red-400" />
                <p className="text-sm text-red-600 text-center">{qrError}</p>
                <Button variant="outline" size="sm"
                  onClick={() => { setQrState('loading'); fetchQr(qrLine!.evolution_instance) }}>
                  Reintentar
                </Button>
              </div>
            )}

          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
