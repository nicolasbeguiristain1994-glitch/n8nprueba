'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RefreshCw, Wifi, WifiOff, QrCode, CheckCircle, Loader2, AlertCircle, ExternalLink } from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'

interface Line {
  id: string; line_key: string; display_name: string; phone_number: string
  evolution_instance: string; status: string; is_connected: boolean
  msgs_sent_today: number; msgs_sent_hour: number
  msg_per_day: number; msg_per_hour: number
  total_sent: number; total_failed: number
  priority: number; last_seen_at: string
}

type QrState = 'idle' | 'loading' | 'not-found' | 'creating' | 'qr' | 'connected' | 'error'

const EVO_MANAGER = process.env.NEXT_PUBLIC_EVOLUTION_MANAGER_URL ?? ''

export default function Lines() {
  const [lines, setLines]     = useState<Line[]>([])
  const [loading, setLoading] = useState(false)

  // QR modal
  const [qrLine, setQrLine]       = useState<Line | null>(null)
  const [qrState, setQrState]     = useState<QrState>('idle')
  const [qrBase64, setQrBase64]   = useState<string | null>(null)
  const [qrError, setQrError]     = useState<string | null>(null)
  const [canCreate, setCanCreate] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    fetchJson<{ lines: Line[] }>('/api/lines')
      .then(d => setLines(d.lines || []))
      .catch(() => setLines([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const stopPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  const closeQr = () => {
    stopPoll()
    setQrLine(null); setQrState('idle'); setQrBase64(null)
    setQrError(null); setCanCreate(false)
  }

  const fetchQr = useCallback(async (instance: string): Promise<boolean> => {
    try {
      const res  = await fetch(`/api/lines/qr?instance=${encodeURIComponent(instance)}`)
      const data = await res.json()

      if (data.connected) {
        setQrState('connected'); stopPoll(); load(); return true
      }
      if (data.notFound) {
        setCanCreate(data.canCreate ?? false)
        setQrState('not-found'); stopPoll(); return false
      }
      if (data.base64) {
        setQrBase64(data.base64); setQrState('qr'); return false
      }
      setQrError(data.error || 'No se pudo obtener el QR'); setQrState('error'); stopPoll(); return false
    } catch {
      setQrError('Error de conexión'); setQrState('error'); stopPoll(); return false
    }
  }, [load])

  const openQrModal = async (line: Line) => {
    setQrLine(line); setQrState('loading'); setQrBase64(null); setQrError(null)
    const done = await fetchQr(line.evolution_instance)
    if (!done) {
      stopPoll()
      pollRef.current = setInterval(() => fetchQr(line.evolution_instance), 5000)
    }
  }

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
        setQrBase64(data.base64); setQrState('qr')
        stopPoll()
        pollRef.current = setInterval(() => fetchQr(qrLine.evolution_instance), 5000)
      } else {
        setQrError('Instancia creada pero no se pudo obtener el QR. Intentá "Obtener QR" de nuevo.')
        setQrState('not-found')
      }
    } catch {
      setQrError('Error al crear la instancia'); setQrState('not-found')
    }
  }

  useEffect(() => () => stopPoll(), [])

  const connected = lines.filter(l => l.is_connected).length
  const active    = lines.filter(l => l.status === 'active').length

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Líneas WhatsApp</h1>
          <p className="text-sm text-gray-500">
            {connected} conectadas · {active} activas · {lines.length} total
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </Button>
      </div>

      {/* Resumen */}
      <div className="grid grid-cols-3 gap-4">
        <Card><CardContent className="pt-4">
          <p className="text-xs text-gray-500 mb-1">Conectadas</p>
          <p className="text-2xl font-bold text-green-600">{connected}</p>
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
                <th className="text-left px-4 py-3 font-medium text-gray-600">Hoy</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Esta hora</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Total enviados</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Acción</th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0
                ? <tr><td colSpan={7} className="text-center py-10 text-gray-400">
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
                          {l.is_connected
                            ? <span className="text-xs text-green-600 flex items-center gap-1">
                                <CheckCircle size={12}/> Conectada
                              </span>
                            : <Button size="sm" variant="outline"
                                className="text-xs border-orange-200 text-orange-700 hover:bg-orange-50"
                                onClick={() => openQrModal(l)}>
                                <QrCode size={13} className="mr-1" /> Vincular QR
                              </Button>
                          }
                        </td>
                      </tr>
                    )
                  })
              }
            </tbody>
          </table>
        </CardContent>
      </Card>

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
            {qrState === 'loading' && (
              <div className="flex flex-col items-center gap-3 py-8">
                <Loader2 size={32} className="animate-spin text-gray-400" />
                <p className="text-sm text-gray-500">Verificando instancia…</p>
              </div>
            )}

            {/* Creando */}
            {qrState === 'creating' && (
              <div className="flex flex-col items-center gap-3 py-8">
                <Loader2 size={32} className="animate-spin text-green-500" />
                <p className="text-sm text-gray-600">Creando instancia en Evolution…</p>
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

                {/* Opción A: crear automáticamente con el key del servidor */}
                {canCreate && (
                  <div className="border rounded-lg p-4 space-y-3">
                    <p className="text-xs font-medium text-gray-700">Crear instancia automáticamente</p>
                    <Button
                      className="w-full bg-green-600 hover:bg-green-700 text-sm"
                      onClick={createInstance}>
                      Crear instancia y obtener QR
                    </Button>
                  </div>
                )}

                {/* Opción B: hacerlo en Evolution Manager */}
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

            {/* QR listo */}
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
                  <p className="text-xs text-orange-500 flex items-center justify-center gap-1 mt-2">
                    <Loader2 size={11} className="animate-spin" /> Esperando escaneo…
                  </p>
                </div>
                <Button variant="outline" size="sm" className="w-full"
                  onClick={() => { setQrState('loading'); fetchQr(qrLine!.evolution_instance) }}>
                  <RefreshCw size={13} className="mr-1" /> Regenerar QR
                </Button>
              </>
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
                <Button variant="outline" size="sm" onClick={() => { setQrState('loading'); fetchQr(qrLine!.evolution_instance) }}>
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
