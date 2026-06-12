'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RefreshCw, Wifi, WifiOff, QrCode, CheckCircle, Check, Loader2, AlertCircle, ExternalLink, ShieldCheck, ShieldOff, LogOut, Plus, RotateCcw, Pencil, Cloud, MessageSquare, Zap, Info, Trash2 } from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'
import { useCurrentUser } from '@/lib/useCurrentUser'

// ─── Tipos para Embedded Signup (Cloud API) ───────────────────────────────────
interface SignupResult {
  authResponse?: { code: string; waba_id: string; phone_number_id: string } | null
  status: string
}
interface OnboardResult {
  cloudNumberId: string; phoneNumberId: string; displayPhone: string
  status: string; message: string
}
declare global {
  interface Window {
    FB: {
      init:  (config: Record<string, unknown>) => void
      login: (callback: (res: SignupResult) => void, options: Record<string, unknown>) => void
    }
    fbAsyncInit?: () => void
  }
}

interface Line {
  id: string; line_key: string; display_name: string; phone_number: string
  evolution_instance: string; status: string; is_connected: boolean
  sending_enabled: boolean; eligible: boolean; line_type: string
  msgs_sent_today: number; msgs_sent_hour: number
  msg_per_day: number; msg_per_hour: number
  total_sent: number; total_failed: number
  priority: number; last_seen_at: string
  cloud_phone_number_id:       string | null
  cloud_waba_id:               string | null
  cloud_quality_rating:        string | null
  cloud_messaging_limit_tier:  string | null
  cloud_coexistence_enabled:   boolean | null
  chatwoot_inbox_id:           string | null
  chatwoot_inbox_name:         string | null
  cloud_status:                string | null
}

// connecting = QR escaneado, handshake en curso — NO regenerar QR en este estado
type QrState = 'idle' | 'loading' | 'not-found' | 'creating' | 'qr' | 'connecting' | 'connected' | 'error'
type AddStep = 'choose-type' | 'evolution' | 'evolution-qr' | 'cloud-mode' | 'cloud-signup'

const EVO_MANAGER  = process.env.NEXT_PUBLIC_EVOLUTION_MANAGER_URL ?? ''

function formatTier(tier: string | null): string {
  switch (tier) {
    case 'TIER_1K':    return '1K / día'
    case 'TIER_10K':   return '10K / día'
    case 'TIER_100K':  return '100K / día'
    case 'UNLIMITED':  return 'Sin límite'
    default:           return '—'
  }
}

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
  const [metaConfigured, setMetaConfigured] = useState(false)
  const [metaAppId,      setMetaAppId]      = useState('')
  const [metaConfigId,   setMetaConfigId]   = useState('')
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

  // Delete modal
  const [deleteTarget, setDeleteTarget]   = useState<Line | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteError, setDeleteError]     = useState<string | null>(null)

  // Detail modal
  const [detailLine, setDetailLine] = useState<Line | null>(null)

  // Edit line modal
  const [editTarget, setEditTarget]         = useState<Line | null>(null)
  const [editForm, setEditForm]             = useState({ display_name: '', msg_per_day: '', msg_per_hour: '', priority: '' })
  const [editLoading, setEditLoading]       = useState(false)
  const [editError, setEditError]           = useState<string | null>(null)

  const openEdit = (l: Line) => {
    setEditTarget(l)
    setEditForm({
      display_name: l.display_name || '',
      msg_per_day:  String(l.msg_per_day),
      msg_per_hour: String(l.msg_per_hour),
      priority:     String(l.priority),
    })
    setEditError(null)
  }

  const saveEdit = async () => {
    if (!editTarget) return
    setEditLoading(true); setEditError(null)
    try {
      const res = await fetch('/api/lines', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id:           editTarget.id,
          display_name: editForm.display_name,
          msg_per_day:  Number(editForm.msg_per_day),
          msg_per_hour: Number(editForm.msg_per_hour),
          priority:     Number(editForm.priority),
        }),
      })
      const data = await res.json()
      if (!res.ok) { setEditError(data.error || 'Error al guardar'); return }
      setEditTarget(null)
      load()
    } catch {
      setEditError('Error de conexión')
    } finally {
      setEditLoading(false)
    }
  }

  // Flujo unificado "Agregar línea": choose-type → evolution | cloud-mode → cloud-signup
  const [addStep,   setAddStep]   = useState<AddStep | null>(null)
  const [cloudMode, setCloudMode] = useState<'official' | 'coexistence' | null>(null)
  const [sdkReady,  setSdkReady]  = useState(false)
  const [cloudLoading,     setCloudLoading]       = useState(false)
  const [cloudResult,      setCloudResult]        = useState<OnboardResult | null>(null)
  const [cloudError,       setCloudError]         = useState<string | null>(null)
  const [cloudLineId,      setCloudLineId]        = useState('')

  // Cargar FB SDK al llegar al paso de Cloud Signup (una sola vez por sesión)
  useEffect(() => {
    if (addStep !== 'cloud-signup') return
    if (!metaAppId) { setCloudError('NEXT_PUBLIC_META_APP_ID no está configurado'); return }
    if (document.getElementById('fb-sdk')) { setSdkReady(true); return }
    window.fbAsyncInit = function () {
      window.FB.init({ appId: metaAppId, autoLogAppEvents: true, xfbml: true, version: 'v21.0' })
      setSdkReady(true)
    }
    const script = document.createElement('script')
    script.id = 'fb-sdk'; script.src = 'https://connect.facebook.net/es_LA/sdk.js'
    script.async = true; script.defer = true
    document.head.appendChild(script)
  }, [addStep])

  const startEmbeddedSignup = useCallback(() => {
    if (!sdkReady) return
    setCloudError(null); setCloudLoading(true)
    window.FB.login(
      async (response: SignupResult) => {
        if (response.status !== 'connected' || !response.authResponse?.code) {
          setCloudError('El usuario canceló el proceso o hubo un error de autorización')
          setCloudLoading(false); return
        }
        const { code, waba_id, phone_number_id } = response.authResponse
        try {
          const res  = await fetch('/api/cloud/onboard', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              code, wabaId: waba_id, phoneNumberId: phone_number_id,
              whatsappLineId:      cloudLineId || undefined,
              coexistenceEnabled:  cloudMode === 'coexistence',
            }),
          })
          const data: OnboardResult & { error?: string } = await res.json()
          if (!res.ok || data.error) setCloudError(data.error ?? 'Error al procesar el onboarding')
          else setCloudResult(data)
        } catch (err) {
          setCloudError(err instanceof Error ? err.message : 'Error de red')
        } finally {
          setCloudLoading(false)
        }
      },
      {
        config_id: metaConfigId,
        response_type: 'code', override_default_response_type: true,
        extras: {
          feature: 'whatsapp_embedded_signup',
          featureType: 'whatsapp_business_app_onboarding',
          setup: {}, sessionInfoVersion: 3,
        },
      },
    )
  }, [sdkReady, cloudLineId, cloudMode])

  const closeAddFlow = () => {
    setAddStep(null); setCloudMode(null)
    setAddInstance(''); setAddDisplayName(''); setAddPhone(''); setAddError(null); setAddLoading(false)
    setCloudResult(null); setCloudError(null); setCloudLineId(''); setSdkReady(false); setCloudLoading(false)
    // Reset QR state in case we were in the evolution-qr step
    stopPoll()
    setQrLine(null); setQrState('idle'); setQrBase64(null)
    setQrError(null); setCanCreate(false); setQrExpiresAt(null)
    load()
  }

  // Chatwoot inbox creation
  const [chatwootTarget, setChatwootTarget]     = useState<Line | null>(null)
  const [chatwootLoading, setChatwootLoading]   = useState(false)
  const [chatwootError, setChatwootError]       = useState<string | null>(null)
  const [chatwootSuccess, setChatwootSuccess]   = useState<string | null>(null)

  const createChatwootInbox = async (line: Line) => {
    if (!line.cloud_phone_number_id) return
    setChatwootLoading(true); setChatwootError(null); setChatwootSuccess(null)
    try {
      const res  = await fetch('/api/cloud/chatwoot-inbox', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumberId: line.cloud_phone_number_id }),
      })
      const data = await res.json()
      if (!res.ok) { setChatwootError(data.error || 'Error al crear inbox'); return }
      setChatwootSuccess(`Inbox "${data.inboxName}" creado (ID: ${data.inboxId})`)
      load()
    } catch {
      setChatwootError('Error de conexión')
    } finally {
      setChatwootLoading(false)
    }
  }

  const closeChatwootModal = () => {
    setChatwootTarget(null); setChatwootError(null); setChatwootSuccess(null)
  }

  const [addInstance, setAddInstance]       = useState('')
  const [addDisplayName, setAddDisplayName] = useState('')
  const [addPhone, setAddPhone]             = useState('')
  const [addLoading, setAddLoading]         = useState(false)
  const [addError, setAddError]             = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    fetchJson<{ lines: Line[], metaConfigured?: boolean, metaAppId?: string, metaConfigId?: string }>('/api/lines')
      .then(d => {
        setLines(d.lines || [])
        setMetaConfigured(d.metaConfigured ?? false)
        setMetaAppId(d.metaAppId ?? '')
        setMetaConfigId(d.metaConfigId ?? '')
      })
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
      await fetch(`/api/lines/qr/status?instance=${encodeURIComponent(line.evolution_instance)}`)
      load()
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
        // Evolution/Baileys pone la instancia en 'connecting' inmediatamente al
        // llamar /instance/connect (antes de que el usuario escanee). Si seguimos
        // mostrando el QR, NO cambiamos el estado para que el usuario pueda escanear.
        // Si ya estábamos en 'connecting', lo mantenemos.
        setQrState(prev => prev === 'qr' ? 'qr' : 'connecting')
        return
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
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), restart ? 25000 : 10000)
      let res: Response
      try {
        res = await fetch(url, { signal: controller.signal })
      } finally {
        clearTimeout(timeout)
      }
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
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'AbortError'
      setQrError(isTimeout ? 'Tiempo de espera agotado. Evolution API no respondió a tiempo.' : 'Error de conexión')
      setQrState('error')
      stopPoll()
      return false
    }
  }, [load])

  // ── openQrModal ─────────────────────────────────────────────────────────────
  // Primera apertura: pide QR normal (sin restart) → respuesta rápida.
  // Si la instancia está en mal estado, el usuario usa "Regenerar QR" que sí
  // hace restart=true (delete+recreate en Evolution).
  const openQrModal = async (line: Line) => {
    setQrLine(line); setQrState('loading'); setQrBase64(null)
    setQrError(null); setQrExpiresAt(null)

    const done = await fetchQr(line.evolution_instance, false)
    if (!done) {
      stopPoll()
      pollRef.current = setInterval(() => pollStatus(line.evolution_instance), STATUS_INTERVAL_MS)
    }
  }

  // ── handleRegenerate ────────────────────────────────────────────────────────
  // Para el polling de estado, hace restart + genera QR nuevo, reanuda polling.
  const handleRegenerate = (instance?: string) => {
    const inst = instance ?? qrLine?.evolution_instance
    if (!inst) return
    stopPoll()
    setQrState('loading')
    setQrBase64(null)
    fetchQr(inst, true).then(done => {
      if (!done) {
        pollRef.current = setInterval(() => pollStatus(inst), STATUS_INTERVAL_MS)
      }
    })
  }

  // ── createInstance ──────────────────────────────────────────────────────────
  const createInstance = async (instanceOverride?: string) => {
    const inst = instanceOverride ?? qrLine?.evolution_instance
    if (!inst) return
    setQrState('creating'); setQrError(null)
    try {
      const res  = await fetch('/api/lines/qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance: inst }),
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
        pollRef.current = setInterval(() => pollStatus(inst), STATUS_INTERVAL_MS)
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

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleteLoading(true)
    setDeleteError(null)
    try {
      const res  = await fetch('/api/lines', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deleteTarget.id }),
      })
      const data = await res.json()
      if (!res.ok) { setDeleteError(data.error || 'Error al eliminar'); return }
      setDeleteTarget(null)
      load()
    } catch {
      setDeleteError('Error de conexión')
    } finally {
      setDeleteLoading(false)
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

      // Si la instancia ya existe (409) mostrar el QR igual (paso evolution-qr dentro del wizard)
      if (res.status === 409 && data.id) {
        setAddStep('evolution-qr')
        // Iniciar fetch del QR dentro del mismo wizard
        setQrState('loading'); setQrBase64(null); setQrError(null); setQrExpiresAt(null)
        const inst = addInstance.trim()
        fetchQr(inst, false).then(done => {
          if (!done) {
            stopPoll()
            pollRef.current = setInterval(() => pollStatus(inst), STATUS_INTERVAL_MS)
          }
        })
        load()
        return
      }

      if (!res.ok) { setAddError(data.error || 'Error al agregar'); return }

      // Transicionar al paso QR dentro del mismo wizard (evita abrir un segundo Dialog)
      setAddStep('evolution-qr')
      setQrState('loading'); setQrBase64(null); setQrError(null); setQrExpiresAt(null)
      const inst = addInstance.trim()
      fetchQr(inst, false).then(done => {
        if (!done) {
          stopPoll()
          pollRef.current = setInterval(() => pollStatus(inst), STATUS_INTERVAL_MS)
        }
      })
      load()
    } catch {
      setAddError('Error de conexión')
    } finally {
      setAddLoading(false)
    }
  }

  const connected      = lines.filter(l => l.is_connected).length
  const active         = lines.filter(l => l.status === 'active').length
  const eligible       = lines.filter(l => l.eligible).length
  const cloudLines     = lines.filter(l => l.line_type === 'cloud').length
  const evolutionLines = lines.filter(l => l.line_type === 'evolution').length

  // Stepper: pasos y posición actual — se adapta a la rama elegida
  const stepperSteps: string[] =
    addStep === 'evolution' || addStep === 'evolution-qr'
      ? ['Tipo de línea', 'Configurar instancia', 'Vincular QR']
      : ['Tipo de línea', 'Modo de conexión', 'Conectar con Meta']
  const stepperIndex =
    addStep === 'evolution'     ? 1 :
    addStep === 'evolution-qr'  ? 2 :
    addStep === 'cloud-mode'    ? 1 :
    addStep === 'cloud-signup'  ? 2 : 0

  const handleStepperBack = (targetIdx: number) => {
    if (targetIdx >= stepperIndex) return
    if (targetIdx === 0) {
      stopPoll()
      setQrState('idle'); setQrBase64(null); setQrError(null); setCanCreate(false)
      setAddStep('choose-type'); setCloudMode(null); setAddError(null); setCloudError(null)
    } else if (targetIdx === 1 && (addStep === 'cloud-signup' || addStep === 'evolution-qr')) {
      if (addStep === 'evolution-qr') {
        stopPoll()
        setQrState('idle'); setQrBase64(null); setQrError(null); setCanCreate(false)
        setAddStep('evolution')
      } else {
        setAddStep('cloud-mode'); setCloudError(null)
      }
    }
  }

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
              onClick={() => setAddStep('choose-type')}>
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
          <p className="text-xs text-gray-500 mb-2">Por proveedor</p>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-100">
                <Cloud size={10} className="text-blue-600" />
              </span>
              <span className="text-xl font-bold text-blue-600">{cloudLines}</span>
              <span className="text-xs text-gray-400">Cloud</span>
            </div>
            <div className="w-px h-6 bg-gray-200" />
            <div className="flex items-center gap-1.5">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-slate-100">
                <Zap size={10} className="text-slate-500" />
              </span>
              <span className="text-xl font-bold text-slate-500">{evolutionLines}</span>
              <span className="text-xs text-gray-400">Evo</span>
            </div>
          </div>
        </CardContent></Card>
      </div>

      {/* Tabla */}
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-gray-600">Línea</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Proveedor</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Estado</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Elegible</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Hoy</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Esta hora</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Total enviados</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Envíos</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Acción</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {lines.length === 0
                ? <tr><td colSpan={10} className="text-center py-10 text-gray-400">
                    {loading ? 'Cargando…' : 'Sin líneas configuradas'}
                  </td></tr>
                : lines.map(l => {
                    const pctDay      = l.msg_per_day  ? (l.msgs_sent_today / l.msg_per_day)  * 100 : 0
                    const pctHour     = l.msg_per_hour ? (l.msgs_sent_hour  / l.msg_per_hour) * 100 : 0
                    const ineligReason = !l.eligible ? (ineligibilityReason(l) ?? 'No elegible') : null
                    return (
                      <tr key={l.id} className={`border-b border-gray-100 transition-colors ${
                        l.line_type === 'cloud' ? 'hover:bg-blue-50/40' : 'hover:bg-gray-50'
                      }`}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {l.is_connected
                              ? <Wifi size={14} className="text-green-500 flex-shrink-0" />
                              : <WifiOff size={14} className="text-gray-300 flex-shrink-0" />
                            }
                            <div>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                {isAdmin
                                  ? <button
                                      onClick={() => openEdit(l)}
                                      className="font-medium hover:text-indigo-600 flex items-center gap-1 group"
                                      title="Editar línea"
                                    >
                                      {l.display_name || l.line_key}
                                      <Pencil size={11} className="text-gray-300 group-hover:text-indigo-400 transition-colors" />
                                    </button>
                                  : <span className="font-medium">{l.display_name || l.line_key}</span>
                                }
                                {l.line_type === 'cloud'
                                  ? <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-600 border border-blue-100">
                                      <Cloud size={8} /> Cloud
                                    </span>
                                  : <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-500 border border-slate-200">
                                      <Zap size={8} /> Evolution
                                    </span>
                                }
                              </div>
                              {l.phone_number && (
                                <div className="text-[10px] text-gray-400 mt-0.5">{l.phone_number}</div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {l.line_type === 'cloud'
                            ? <div className="flex flex-col gap-1">
                                {l.cloud_quality_rating
                                  ? <span className={`flex items-center gap-1.5 font-medium ${
                                      l.cloud_quality_rating === 'GREEN'  ? 'text-green-700' :
                                      l.cloud_quality_rating === 'YELLOW' ? 'text-yellow-700' :
                                      'text-red-700'
                                    }`}>
                                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                                        l.cloud_quality_rating === 'GREEN'  ? 'bg-green-500' :
                                        l.cloud_quality_rating === 'YELLOW' ? 'bg-yellow-400' :
                                        'bg-red-500'
                                      }`} />
                                      {l.cloud_quality_rating === 'GREEN'  ? 'Calidad alta' :
                                       l.cloud_quality_rating === 'YELLOW' ? 'Calidad media' :
                                       'Calidad baja'}
                                    </span>
                                  : <span className="text-gray-400">Sin rating</span>
                                }
                                {l.cloud_coexistence_enabled && (
                                  <span className="flex items-center gap-1 text-violet-700 font-medium">
                                    <Zap size={9} className="flex-shrink-0" />
                                    App + API
                                  </span>
                                )}
                                {l.chatwoot_inbox_id
                                  ? <span className="flex items-center gap-1 text-violet-600">
                                      <MessageSquare size={10} className="flex-shrink-0" />
                                      <span className="truncate max-w-[140px]" title={l.chatwoot_inbox_name || ''}>
                                        {l.chatwoot_inbox_name || `Inbox #${l.chatwoot_inbox_id}`}
                                      </span>
                                    </span>
                                  : <span className="text-gray-400">Sin inbox</span>
                                }
                                <span className={`self-start inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                  l.cloud_messaging_limit_tier === 'UNLIMITED' ? 'bg-indigo-100 text-indigo-700' :
                                  l.cloud_messaging_limit_tier               ? 'bg-slate-100 text-slate-600' :
                                                                               'bg-gray-50  text-gray-400'
                                }`}>
                                  {formatTier(l.cloud_messaging_limit_tier)}
                                </span>
                              </div>
                            : <span className="font-mono text-[11px] text-gray-500">{l.evolution_instance}</span>
                          }
                        </td>
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
                            : <span className="flex items-center gap-1 text-xs text-red-400" title={ineligReason ?? undefined}>
                                <ShieldOff size={13}/> No
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
                          {isAdmin
                            ? <button
                                onClick={() => toggleSending(l)}
                                disabled={toggling === l.id}
                                title={l.sending_enabled ? 'Desactivar envíos de campaña' : 'Activar envíos de campaña'}
                                className={`relative inline-flex w-9 h-5 rounded-full transition-colors focus:outline-none ${
                                  l.sending_enabled ? 'bg-green-500' : 'bg-gray-300'
                                } ${toggling === l.id ? 'opacity-50' : ''}`}
                              >
                                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${l.sending_enabled ? 'translate-x-4' : ''}`} />
                              </button>
                            : <span className={`inline-block w-9 h-5 rounded-full ${l.sending_enabled ? 'bg-green-400' : 'bg-gray-200'}`} />
                          }
                        </td>
                        <td className="px-4 py-3">
                          {l.line_type === 'cloud'
                            ? <div className="flex items-center gap-1.5">
                                {isAdmin && !l.chatwoot_inbox_id && l.cloud_phone_number_id && (
                                  <Button size="sm" variant="outline"
                                    className="text-xs border-violet-200 text-violet-700 hover:bg-violet-50 h-7 px-2"
                                    onClick={() => { setChatwootTarget(l); setChatwootError(null); setChatwootSuccess(null) }}>
                                    <MessageSquare size={11} className="mr-1" /> Crear Inbox
                                  </Button>
                                )}
                                {l.chatwoot_inbox_id && (
                                  <span className="text-xs text-green-600 flex items-center gap-1">
                                    <CheckCircle size={12}/> Conectada
                                  </span>
                                )}
                                {!l.chatwoot_inbox_id && (!isAdmin || !l.cloud_phone_number_id) && (
                                  <span className="text-xs text-blue-500 flex items-center gap-1">
                                    <CheckCircle size={12}/> Activa
                                  </span>
                                )}
                              </div>
                            : l.is_connected
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
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-0.5">
                            <button
                              onClick={() => setDetailLine(l)}
                              title="Ver detalle"
                              className="p-1.5 rounded text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                            >
                              <Info size={14} />
                            </button>
                            {isAdmin && l.is_connected && l.line_type !== 'cloud' && (
                              <button
                                onClick={() => { setUnlinkTarget(l); setUnlinkError(null) }}
                                title="Desvincular línea"
                                className="p-1.5 rounded text-gray-400 hover:text-orange-600 hover:bg-orange-50 transition-colors"
                              >
                                <LogOut size={14} />
                              </button>
                            )}
                            {isAdmin && (
                              <button
                                onClick={() => { setDeleteTarget(l); setDeleteError(null) }}
                                title="Eliminar línea"
                                className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                              >
                                <Trash2 size={14} />
                              </button>
                            )}
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

      {/* ── Modal detalle de línea ── */}
      <Dialog open={!!detailLine} onOpenChange={open => { if (!open) setDetailLine(null) }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5">
              {detailLine?.line_type === 'cloud'
                ? <span className="p-1.5 rounded-lg bg-blue-50"><Cloud size={15} className="text-blue-500" /></span>
                : <span className="p-1.5 rounded-lg bg-slate-100"><Zap  size={15} className="text-slate-500" /></span>
              }
              <div>
                <span className="text-base font-semibold">{detailLine?.display_name || detailLine?.line_key}</span>
                {detailLine?.phone_number && (
                  <p className="text-xs font-normal text-gray-400 mt-0.5">{detailLine.phone_number}</p>
                )}
              </div>
            </DialogTitle>
          </DialogHeader>

          {detailLine && (
            <div className="space-y-3 py-1 max-h-[70vh] overflow-y-auto pr-1">

              {/* ── Badges de estado ── */}
              <div className="flex items-center gap-2 flex-wrap">
                {detailLine.line_type === 'cloud'
                  ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-blue-50 text-blue-600 border border-blue-100">
                      <Cloud size={9} /> Cloud API
                    </span>
                  : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-500 border border-slate-200">
                      <Zap size={9} /> Evolution
                    </span>
                }
                <Badge
                  variant={detailLine.status === 'active' && detailLine.is_connected ? 'default' : 'secondary'}
                  className={`text-xs ${detailLine.status === 'active' && detailLine.is_connected ? 'bg-green-100 text-green-700' : ''}`}>
                  {detailLine.is_connected ? detailLine.status : 'desconectada'}
                </Badge>
                {detailLine.eligible
                  ? <span className="flex items-center gap-1 text-xs text-green-600"><ShieldCheck size={12}/> Elegible</span>
                  : <span className="flex items-center gap-1 text-xs text-red-400" title={ineligibilityReason(detailLine) ?? ''}>
                      <ShieldOff size={12}/> {ineligibilityReason(detailLine) ?? 'No elegible'}
                    </span>
                }
              </div>

              {/* ── Sección Cloud ── */}
              {detailLine.line_type === 'cloud' && (
                <>
                  <div className="rounded-xl border border-gray-100 bg-gray-50/80 p-4 space-y-3">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Calidad y límites</p>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <p className="text-[10px] text-gray-400">Quality Rating</p>
                        {detailLine.cloud_quality_rating
                          ? <span className={`flex items-center gap-1.5 text-sm font-semibold ${
                              detailLine.cloud_quality_rating === 'GREEN'  ? 'text-green-700' :
                              detailLine.cloud_quality_rating === 'YELLOW' ? 'text-yellow-700' : 'text-red-700'
                            }`}>
                              <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                                detailLine.cloud_quality_rating === 'GREEN'  ? 'bg-green-500' :
                                detailLine.cloud_quality_rating === 'YELLOW' ? 'bg-yellow-400' : 'bg-red-500'
                              }`} />
                              {detailLine.cloud_quality_rating === 'GREEN'  ? 'Alta — sin restricciones' :
                               detailLine.cloud_quality_rating === 'YELLOW' ? 'Media — monitorear' :
                               'Baja — envíos limitados'}
                            </span>
                          : <span className="text-sm text-gray-400">Sin datos</span>
                        }
                      </div>
                      <div className="space-y-1">
                        <p className="text-[10px] text-gray-400">Tier de envíos</p>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold ${
                          detailLine.cloud_messaging_limit_tier === 'UNLIMITED' ? 'bg-indigo-100 text-indigo-700' :
                          detailLine.cloud_messaging_limit_tier                 ? 'bg-slate-100 text-slate-700' :
                                                                                  'bg-gray-100  text-gray-400'
                        }`}>
                          {formatTier(detailLine.cloud_messaging_limit_tier)}
                        </span>
                      </div>
                    </div>
                    <div className="space-y-1 pt-1 border-t border-gray-100">
                      <p className="text-[10px] text-gray-400">Modo de conexión</p>
                      {detailLine.cloud_coexistence_enabled
                        ? <span className="flex items-center gap-1.5 text-sm font-semibold text-violet-700">
                            <Zap size={13} /> Coexistencia — WhatsApp App + API simultáneamente
                          </span>
                        : <span className="flex items-center gap-1.5 text-sm font-semibold text-blue-700">
                            <Cloud size={13} /> API Oficial — solo Cloud API
                          </span>
                      }
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-100 bg-gray-50/80 p-4 space-y-2.5">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Chatwoot</p>
                    {detailLine.chatwoot_inbox_id
                      ? <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <MessageSquare size={15} className="text-violet-500" />
                            <div>
                              <p className="text-sm font-medium text-violet-700">
                                {detailLine.chatwoot_inbox_name || `Inbox #${detailLine.chatwoot_inbox_id}`}
                              </p>
                              <p className="text-[10px] text-gray-400">ID: {detailLine.chatwoot_inbox_id}</p>
                            </div>
                          </div>
                          <span className="flex items-center gap-1 text-xs text-green-600 font-medium">
                            <CheckCircle size={12} /> Conectado
                          </span>
                        </div>
                      : <div className="flex items-center justify-between">
                          <span className="text-sm text-gray-400">Sin inbox vinculado</span>
                          {isAdmin && detailLine.cloud_phone_number_id && (
                            <Button size="sm" variant="outline"
                              className="text-xs border-violet-200 text-violet-700 hover:bg-violet-50 h-7 px-2.5"
                              onClick={() => {
                                setDetailLine(null)
                                setChatwootTarget(detailLine)
                                setChatwootError(null); setChatwootSuccess(null)
                              }}>
                              <MessageSquare size={11} className="mr-1" /> Crear Inbox
                            </Button>
                          )}
                        </div>
                    }
                  </div>
                </>
              )}

              {/* ── Sección Evolution ── */}
              {detailLine.line_type === 'evolution' && (
                <div className="rounded-xl border border-gray-100 bg-gray-50/80 p-4 space-y-2">
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Instancia Evolution</p>
                  <p className="font-mono text-sm text-gray-700 select-all">{detailLine.evolution_instance}</p>
                  {detailLine.last_seen_at && (
                    <p className="text-[10px] text-gray-400">
                      Último contacto: {new Date(detailLine.last_seen_at).toLocaleString('es-AR')}
                    </p>
                  )}
                </div>
              )}

              {/* ── Estadísticas ── */}
              <div className="rounded-xl border border-gray-100 bg-gray-50/80 p-4 space-y-3">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Estadísticas de uso</p>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <p className="text-[10px] text-gray-400">Hoy</p>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-gray-200 rounded-full h-1.5">
                        <div className="bg-green-500 h-1.5 rounded-full transition-all" style={{
                          width: `${Math.min(detailLine.msg_per_day ? (detailLine.msgs_sent_today / detailLine.msg_per_day) * 100 : 0, 100)}%`
                        }} />
                      </div>
                      <span className="text-xs text-gray-600 font-medium whitespace-nowrap tabular-nums">
                        {detailLine.msgs_sent_today.toLocaleString()} / {detailLine.msg_per_day.toLocaleString()}
                      </span>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-[10px] text-gray-400">Esta hora</p>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-gray-200 rounded-full h-1.5">
                        <div className="bg-blue-400 h-1.5 rounded-full transition-all" style={{
                          width: `${Math.min(detailLine.msg_per_hour ? (detailLine.msgs_sent_hour / detailLine.msg_per_hour) * 100 : 0, 100)}%`
                        }} />
                      </div>
                      <span className="text-xs text-gray-600 font-medium whitespace-nowrap tabular-nums">
                        {detailLine.msgs_sent_hour} / {detailLine.msg_per_hour}
                      </span>
                    </div>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-400 mb-0.5">Total enviados</p>
                    <p className="text-2xl font-bold text-gray-800 tabular-nums">{detailLine.total_sent.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-gray-400 mb-0.5">Total fallidos</p>
                    <p className={`text-2xl font-bold tabular-nums ${detailLine.total_failed > 0 ? 'text-red-500' : 'text-gray-300'}`}>
                      {detailLine.total_failed.toLocaleString()}
                    </p>
                  </div>
                </div>
                <div className="pt-1 border-t border-gray-100 text-[10px] text-gray-400">
                  Prioridad de despacho: {detailLine.priority} · Envíos: {detailLine.sending_enabled ? 'habilitados' : 'deshabilitados'}
                </div>
              </div>

              {/* ── Acciones ── */}
              {isAdmin && (
                <div className="flex gap-2 pt-1 flex-wrap border-t border-gray-100">
                  <Button size="sm" variant="outline" className="text-xs h-8"
                    onClick={() => { setDetailLine(null); openEdit(detailLine) }}>
                    <Pencil size={12} className="mr-1" /> Editar límites
                  </Button>
                  {detailLine.line_type === 'evolution' && !detailLine.is_connected && (
                    <Button size="sm" variant="outline"
                      className="text-xs h-8 border-orange-200 text-orange-700 hover:bg-orange-50"
                      onClick={() => { setDetailLine(null); openQrModal(detailLine) }}>
                      <QrCode size={12} className="mr-1" /> Vincular QR
                    </Button>
                  )}
                  {detailLine.is_connected && detailLine.line_type !== 'cloud' && (
                    <Button size="sm" variant="outline"
                      className="text-xs h-8 border-orange-200 text-orange-700 hover:bg-orange-50"
                      onClick={() => { setDetailLine(null); setUnlinkTarget(detailLine); setUnlinkError(null) }}>
                      <LogOut size={12} className="mr-1" /> Desvincular
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Modal editar línea ── */}
      <Dialog open={!!editTarget} onOpenChange={open => { if (!open) { setEditTarget(null); setEditError(null) } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil size={16} /> Editar línea
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">Nombre para mostrar</label>
              <Input
                value={editForm.display_name}
                onChange={e => setEditForm(f => ({ ...f, display_name: e.target.value }))}
                onKeyDown={e => e.key === 'Enter' && saveEdit()}
                placeholder="ej: Línea 01"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-700">Límite diario</label>
                <Input
                  type="number" min={1}
                  value={editForm.msg_per_day}
                  onChange={e => setEditForm(f => ({ ...f, msg_per_day: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-700">Límite por hora</label>
                <Input
                  type="number" min={1}
                  value={editForm.msg_per_hour}
                  onChange={e => setEditForm(f => ({ ...f, msg_per_hour: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">Prioridad <span className="text-gray-400 font-normal">(menor número = mayor prioridad)</span></label>
              <Input
                type="number"
                value={editForm.priority}
                onChange={e => setEditForm(f => ({ ...f, priority: e.target.value }))}
              />
            </div>
            {editError && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{editError}</p>
            )}
            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" disabled={editLoading}
                onClick={() => { setEditTarget(null); setEditError(null) }}>
                Cancelar
              </Button>
              <Button className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white" disabled={editLoading || !editForm.display_name.trim()}
                onClick={saveEdit}>
                {editLoading ? <Loader2 size={14} className="animate-spin mr-1" /> : null}
                Guardar
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Modal crear inbox Chatwoot ── */}
      <Dialog open={!!chatwootTarget} onOpenChange={open => { if (!open) closeChatwootModal() }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-violet-700">
              <MessageSquare size={16} /> Crear Inbox en Chatwoot
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {chatwootSuccess
              ? <div className="space-y-3">
                  <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded p-3">{chatwootSuccess}</p>
                  <Button className="w-full" onClick={closeChatwootModal}>Cerrar</Button>
                </div>
              : <>
                  <p className="text-sm text-gray-700">
                    Se creará un inbox de <span className="font-semibold">WhatsApp Cloud</span> en Chatwoot para{' '}
                    <span className="font-semibold">{chatwootTarget?.display_name || chatwootTarget?.phone_number}</span>.
                  </p>
                  {chatwootError && (
                    <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{chatwootError}</p>
                  )}
                  <div className="flex gap-2">
                    <Button variant="outline" className="flex-1" disabled={chatwootLoading} onClick={closeChatwootModal}>
                      Cancelar
                    </Button>
                    <Button
                      className="flex-1 bg-violet-600 hover:bg-violet-700 text-white"
                      disabled={chatwootLoading}
                      onClick={() => chatwootTarget && createChatwootInbox(chatwootTarget)}>
                      {chatwootLoading ? <Loader2 size={14} className="animate-spin mr-1" /> : <MessageSquare size={14} className="mr-1" />}
                      Crear Inbox
                    </Button>
                  </div>
                </>
            }
          </div>
        </DialogContent>
      </Dialog>

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

      {/* ── Modal eliminar línea ── */}
      <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open) { setDeleteTarget(null); setDeleteError(null) } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <Trash2 size={16} /> Eliminar línea
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-gray-700">
              ¿Eliminar permanentemente <span className="font-semibold">{deleteTarget?.display_name || deleteTarget?.line_key}</span>?
              Esta acción <span className="font-medium">no se puede deshacer</span> y borrará la línea del sistema.
            </p>
            {deleteError && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{deleteError}</p>
            )}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" disabled={deleteLoading}
                onClick={() => { setDeleteTarget(null); setDeleteError(null) }}>
                Cancelar
              </Button>
              <Button className="flex-1 bg-red-600 hover:bg-red-700 text-white" disabled={deleteLoading}
                onClick={confirmDelete}>
                {deleteLoading ? <Loader2 size={14} className="animate-spin mr-1" /> : <Trash2 size={14} className="mr-1" />}
                Eliminar
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Modal agregar línea (flujo unificado) ── */}
      <Dialog open={addStep !== null} onOpenChange={open => { if (!open) closeAddFlow() }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {addStep === 'choose-type'   && <><Plus    size={16} /> Agregar línea</>}
              {addStep === 'evolution'     && <><Zap    size={16} className="text-slate-500" /> Agregar línea Evolution</>}
              {addStep === 'evolution-qr'  && <><QrCode size={16} className="text-indigo-500" /> Vincular línea Evolution</>}
              {addStep === 'cloud-mode'    && <><Cloud  size={16} className="text-blue-500"  /> WhatsApp Cloud API</>}
              {addStep === 'cloud-signup'  && <><Cloud  size={16} className="text-blue-500"  /> Conectar número de WhatsApp</>}
            </DialogTitle>
          </DialogHeader>

          {/* ── Stepper — visible desde el paso 2 (una vez elegido el tipo) ── */}
          {addStep !== null && addStep !== 'choose-type' && (
            <div className="flex items-start justify-center pb-3 border-b border-gray-100">
              {stepperSteps.map((label, i) => {
                const done     = i < stepperIndex
                const current  = i === stepperIndex
                const clickable = done
                return (
                  <div key={i} className="flex items-center">
                    <button
                      type="button"
                      disabled={!clickable}
                      onClick={() => handleStepperBack(i)}
                      className={`flex flex-col items-center gap-1.5 w-20 ${
                        clickable ? 'cursor-pointer' : 'cursor-default'
                      }`}
                    >
                      <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold transition-all ${
                        done    ? 'bg-green-500 text-white' :
                        current ? 'bg-indigo-600 text-white ring-4 ring-indigo-100' :
                                  'bg-gray-100 text-gray-400'
                      }`}>
                        {done ? <Check size={11} /> : i + 1}
                      </span>
                      <span className={`text-[10px] font-medium text-center leading-tight ${
                        current ? 'text-indigo-600' :
                        done    ? 'text-gray-500'   :
                                  'text-gray-400'
                      }`}>
                        {label}
                      </span>
                    </button>
                    {i < stepperSteps.length - 1 && (
                      <div className={`h-px w-8 flex-shrink-0 mb-5 ${
                        i < stepperIndex ? 'bg-green-400' : 'bg-gray-200'
                      }`} />
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* ── Paso 1: Elegir tipo ───────────────────────────────────────── */}
          {addStep === 'choose-type' && (
            <div className="space-y-4 py-1">
              <p className="text-sm text-gray-500">Elegí el tipo de línea que querés agregar a la plataforma.</p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => setAddStep('evolution')}
                  className="flex flex-col gap-3 p-4 rounded-xl border-2 border-gray-200 hover:border-indigo-400 hover:bg-indigo-50/40 text-left transition-all group"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="p-2 rounded-lg bg-slate-100 group-hover:bg-indigo-100 transition-colors">
                      <Zap size={16} className="text-slate-500 group-hover:text-indigo-600 transition-colors" />
                    </span>
                    <span className="font-semibold text-sm">Evolution</span>
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-gray-600">WhatsApp via código QR</p>
                    <p className="text-xs text-gray-400 leading-relaxed">Ideal para números de empresa o personales ya activos. Configuración en minutos.</p>
                  </div>
                </button>

                <button
                  onClick={() => setAddStep('cloud-mode')}
                  className="flex flex-col gap-3 p-4 rounded-xl border-2 border-gray-200 hover:border-blue-400 hover:bg-blue-50/40 text-left transition-all group"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="p-2 rounded-lg bg-blue-50 group-hover:bg-blue-100 transition-colors">
                      <Cloud size={16} className="text-blue-500" />
                    </span>
                    <div>
                      <p className="font-semibold text-sm leading-tight">WhatsApp Cloud</p>
                      <span className="text-[10px] font-semibold text-green-600">Recomendado</span>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-gray-600">API oficial de Meta</p>
                    <p className="text-xs text-gray-400 leading-relaxed">Mayor confiabilidad para campañas masivas, plantillas y automatización.</p>
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* ── Paso 2a: Línea Evolution ──────────────────────────────────── */}
          {addStep === 'evolution' && (
            <div className="space-y-3 py-1">
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
              {addError && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{addError}</p>
              )}
              <div className="flex gap-2 pt-1">
                <Button variant="outline" className="flex-1" disabled={addLoading}
                  onClick={() => { setAddStep('choose-type'); setAddError(null) }}>
                  ← Atrás
                </Button>
                <Button className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white"
                  disabled={addLoading || !addInstance.trim()} onClick={addLine}>
                  {addLoading ? <Loader2 size={14} className="animate-spin mr-1" /> : <Plus size={14} className="mr-1" />}
                  Agregar
                </Button>
              </div>
            </div>
          )}

          {/* ── Paso 3a: QR Evolution (inline, sin abrir otro Dialog) ──────── */}
          {addStep === 'evolution-qr' && (
            <div className="flex flex-col items-center gap-4 py-2">

              {(qrState === 'loading' || qrState === 'creating') && (
                <div className="flex flex-col items-center gap-3 py-8">
                  <Loader2 size={32} className="animate-spin text-gray-400" />
                  <p className="text-sm text-gray-500">
                    {qrState === 'creating' ? 'Creando instancia en Evolution…' : 'Verificando instancia…'}
                  </p>
                </div>
              )}

              {qrState === 'not-found' && (
                <div className="w-full space-y-4">
                  <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 text-sm">
                    <p className="font-medium text-orange-800 mb-1">Instancia no registrada en Evolution</p>
                    <p className="text-orange-600 text-xs">
                      La instancia <code className="bg-orange-100 px-1 rounded font-mono">{addInstance}</code> no existe en Evolution API.
                    </p>
                  </div>
                  {qrError && (
                    <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-3">{qrError}</p>
                  )}
                  {canCreate && (
                    <Button className="w-full bg-green-600 hover:bg-green-700 text-sm"
                      onClick={() => createInstance(addInstance)}>
                      Crear instancia y obtener QR
                    </Button>
                  )}
                  <div className="flex gap-2">
                    {EVO_MANAGER && (
                      <a href={EVO_MANAGER} target="_blank" rel="noreferrer" className="flex-1">
                        <Button variant="outline" size="sm" className="w-full text-xs">
                          <ExternalLink size={12} className="mr-1" /> Abrir Evolution Manager
                        </Button>
                      </a>
                    )}
                    <Button size="sm" variant="outline" className="flex-1 text-xs"
                      onClick={() => { setQrState('loading'); fetchQr(addInstance, false).then(done => { if (!done) { stopPoll(); pollRef.current = setInterval(() => pollStatus(addInstance), STATUS_INTERVAL_MS) } }) }}>
                      <RefreshCw size={12} className="mr-1" /> Obtener QR
                    </Button>
                  </div>
                </div>
              )}

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
                          <Loader2 size={11} className="animate-spin" />Escaneá ahora · expira en {timeLeft}s
                        </p>
                      : timeLeft > 0
                      ? <p className="text-xs text-red-500 font-semibold flex items-center justify-center gap-1 mt-1">
                          <Loader2 size={11} className="animate-spin" />Apurate — expira en {timeLeft}s
                        </p>
                      : <p className="text-xs text-red-500 font-medium mt-1">QR expirado · hacé clic en Regenerar</p>
                    }
                  </div>
                  <Button variant="outline" size="sm" className="w-full"
                    disabled={timeLeft > 0 && timeLeft <= 3}
                    onClick={() => handleRegenerate(addInstance)}>
                    <RefreshCw size={13} className="mr-1" />
                    {timeLeft === 0 ? 'Obtener nuevo QR' : 'Regenerar QR'}
                  </Button>
                </>
              )}

              {qrState === 'connecting' && (
                <div className="flex flex-col items-center gap-3 py-8">
                  <Loader2 size={36} className="animate-spin text-blue-500" />
                  <p className="text-sm font-semibold text-blue-700">Vinculando dispositivo…</p>
                  <p className="text-xs text-gray-500 text-center">
                    Confirmá en tu teléfono si WhatsApp lo solicita.<br />
                    No cierres esta ventana ni regeneres el QR.
                  </p>
                  <button onClick={() => handleRegenerate(addInstance)}
                    className="mt-2 text-xs text-gray-400 underline hover:text-gray-600">
                    ¿Sigue cargando? Forzar nuevo QR
                  </button>
                </div>
              )}

              {qrState === 'connected' && (
                <div className="flex flex-col items-center gap-3 py-6">
                  <CheckCircle size={48} className="text-green-500" />
                  <p className="text-base font-semibold text-green-700">¡Línea conectada!</p>
                  <p className="text-sm text-gray-500 text-center">
                    {addDisplayName || addInstance} está lista para enviar mensajes.
                  </p>
                  <Button className="w-full bg-green-600 hover:bg-green-700" onClick={closeAddFlow}>Cerrar</Button>
                </div>
              )}

              {qrState === 'error' && (
                <div className="flex flex-col items-center gap-3 py-6">
                  <AlertCircle size={40} className="text-red-400" />
                  <p className="text-sm text-red-600 text-center">{qrError}</p>
                  <Button variant="outline" size="sm"
                    onClick={() => { setQrState('loading'); fetchQr(addInstance, false).then(done => { if (!done) { stopPoll(); pollRef.current = setInterval(() => pollStatus(addInstance), STATUS_INTERVAL_MS) } }) }}>
                    Reintentar
                  </Button>
                </div>
              )}

            </div>
          )}

          {/* ── Paso 2b: Elegir modo Cloud ────────────────────────────────── */}
          {addStep === 'cloud-mode' && (
            <div className="space-y-4 py-1">
              {/* Advertencia: NEXT_PUBLIC_META_CONFIG_ID no configurada */}
              {!metaConfigured && (
                <div className="flex gap-2.5 items-start p-3 rounded-lg bg-amber-50 border border-amber-200">
                  <AlertCircle size={15} className="flex-shrink-0 mt-0.5 text-amber-500" />
                  <div className="space-y-1">
                    <p className="text-xs font-semibold text-amber-800">Configuración requerida</p>
                    <p className="text-xs text-amber-700 leading-relaxed">
                      La variable de entorno{' '}
                      <code className="bg-amber-100 px-1 py-0.5 rounded font-mono text-[11px]">
                        NEXT_PUBLIC_META_CONFIG_ID
                      </code>{' '}
                      no está configurada. Sin ella, el Embedded Signup de Meta no puede iniciarse.
                    </p>
                    <p className="text-xs text-amber-600">
                      Configurala en el servidor y volvé a desplegar la aplicación para habilitar esta opción.
                    </p>
                  </div>
                </div>
              )}

              <p className="text-sm text-gray-500">¿Cómo querés usar este número de WhatsApp?</p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  disabled={!metaConfigured}
                  onClick={() => { setCloudMode('official'); setAddStep('cloud-signup') }}
                  className={`flex flex-col gap-3 p-4 rounded-xl border-2 text-left transition-all ${
                    metaConfigured
                      ? 'border-gray-200 hover:border-blue-400 hover:bg-blue-50/40 cursor-pointer'
                      : 'border-gray-100 bg-gray-50 opacity-50 cursor-not-allowed'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="p-1.5 rounded-lg bg-blue-50">
                      <Cloud size={15} className="text-blue-500" />
                    </span>
                    <div>
                      <p className="font-semibold text-sm leading-tight">API Oficial</p>
                      <span className="text-[10px] font-semibold text-blue-600">Recomendado</span>
                    </div>
                  </div>
                  <p className="text-xs text-gray-400 leading-relaxed">Solo Cloud API. Máxima velocidad para campañas, bots y automatización sin límites de app.</p>
                  <div className="space-y-0.5">
                    <p className="text-[11px] text-green-600">✓ Plantillas Meta aprobadas</p>
                    <p className="text-[11px] text-green-600">✓ Tiers de hasta 100K/día</p>
                  </div>
                </button>

                <button
                  disabled={!metaConfigured}
                  onClick={() => { setCloudMode('coexistence'); setAddStep('cloud-signup') }}
                  className={`flex flex-col gap-3 p-4 rounded-xl border-2 text-left transition-all ${
                    metaConfigured
                      ? 'border-gray-200 hover:border-violet-400 hover:bg-violet-50/40 cursor-pointer'
                      : 'border-gray-100 bg-gray-50 opacity-50 cursor-not-allowed'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="p-1.5 rounded-lg bg-violet-50">
                      <MessageSquare size={15} className="text-violet-500" />
                    </span>
                    <p className="font-semibold text-sm">Coexistencia</p>
                  </div>
                  <p className="text-xs text-gray-400 leading-relaxed">API + WhatsApp Business App al mismo tiempo. Ideal si el cliente sigue usando la app.</p>
                  <div className="space-y-0.5">
                    <p className="text-[11px] text-green-600">✓ Seguís usando la app</p>
                    <p className="text-[11px] text-green-600">✓ Historial hasta 180 días</p>
                  </div>
                </button>
              </div>
              <button onClick={() => setAddStep('choose-type')}
                className="text-xs text-gray-400 hover:text-gray-600 underline underline-offset-2 transition-colors">
                ← Volver a elegir tipo
              </button>
            </div>
          )}

          {/* ── Paso 3: Cloud Signup ──────────────────────────────────────── */}
          {addStep === 'cloud-signup' && (
            <div className="space-y-4 py-1">
              {/* Badge modo seleccionado */}
              {cloudMode && !cloudResult && (
                <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border ${
                  cloudMode === 'official'
                    ? 'bg-blue-50 text-blue-700 border-blue-100'
                    : 'bg-violet-50 text-violet-700 border-violet-100'
                }`}>
                  {cloudMode === 'official'
                    ? <><Cloud size={13} /> Modo: API Oficial</>
                    : <><MessageSquare size={13} /> Modo: Coexistencia — el número seguirá funcionando en la app al mismo tiempo</>
                  }
                </div>
              )}

              <p className="text-sm text-gray-500">
                Autorizá tu cuenta de Meta Business para conectar el número a la plataforma.
              </p>

              {/* Línea existente a vincular */}
              {!cloudResult && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-gray-700">
                    Línea existente a vincular <span className="text-gray-400 font-normal">(opcional)</span>
                  </label>
                  <Input
                    placeholder="UUID de la línea en la plataforma"
                    value={cloudLineId}
                    onChange={e => setCloudLineId(e.target.value)}
                  />
                </div>
              )}

              {/* Botón principal */}
              {!cloudResult && (
                <button
                  onClick={startEmbeddedSignup}
                  disabled={!sdkReady || cloudLoading || !!cloudError?.includes('META_APP_ID')}
                  className="w-full bg-green-600 text-white font-semibold py-3 rounded-xl
                             hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed
                             flex items-center justify-center gap-2 text-sm"
                >
                  {cloudLoading ? (
                    <><Loader2 size={14} className="animate-spin" /> Procesando...</>
                  ) : !sdkReady && !cloudError ? (
                    <><Loader2 size={14} className="animate-spin" /> Cargando SDK de Meta...</>
                  ) : (
                    'Conectar con Meta Business'
                  )}
                </button>
              )}

              {/* Error */}
              {cloudError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                  <strong>Error:</strong> {cloudError}
                </div>
              )}

              {/* Éxito */}
              {cloudResult && (
                <div className="space-y-3">
                  <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                    <h3 className="font-semibold text-green-800 mb-2">Número registrado</h3>
                    <dl className="text-sm space-y-1">
                      <div className="flex gap-2">
                        <dt className="text-gray-500 w-24">Número:</dt>
                        <dd className="font-mono font-medium">{cloudResult.displayPhone}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="text-gray-500 w-24">Estado:</dt>
                        <dd>
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            cloudResult.status === 'active'
                              ? 'bg-green-100 text-green-800'
                              : 'bg-yellow-100 text-yellow-800'
                          }`}>
                            {cloudResult.status}
                          </span>
                        </dd>
                      </div>
                    </dl>
                    <p className="mt-2 text-sm text-gray-600">{cloudResult.message}</p>
                  </div>

                  {cloudResult.status === 'code_sent' && (
                    <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
                      <strong>Próximo paso:</strong> El cliente debe ingresar el código en su <strong>WhatsApp Business App</strong>.
                      Una vez verificado, la sincronización comenzará automáticamente (hasta 15 minutos).
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Button variant="outline" className="flex-1 text-sm"
                      onClick={() => { setCloudResult(null); setCloudError(null) }}>
                      Conectar otro número
                    </Button>
                    <Button className="flex-1 bg-green-600 hover:bg-green-700 text-white text-sm"
                      onClick={closeAddFlow}>
                      Cerrar
                    </Button>
                  </div>
                </div>
              )}

              {/* Volver atrás */}
              {!cloudResult && (
                <button onClick={() => { setAddStep('cloud-mode'); setCloudError(null) }}
                  className="text-xs text-gray-400 hover:text-gray-600 underline underline-offset-2 transition-colors">
                  ← Volver a elegir modo
                </button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Modal QR — solo para líneas existentes (no para el flujo evolution-qr del wizard) ── */}
      <Dialog open={!!qrLine && addStep === null} onOpenChange={open => { if (!open) closeQr() }}>
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
                    <Button className="w-full bg-green-600 hover:bg-green-700 text-sm" onClick={() => createInstance()}>
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
                  onClick={() => handleRegenerate()}
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
                <button
                  onClick={() => handleRegenerate()}
                  className="mt-2 text-xs text-gray-400 underline hover:text-gray-600"
                >
                  ¿Sigue cargando? Forzar nuevo QR
                </button>
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
