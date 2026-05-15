'use client'
import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  RefreshCw, Plus, Flame, Pause, Play, Trash2,
  QrCode, CheckCircle, Loader2, AlertCircle, ExternalLink,
  ArrowRight, Pencil, Wifi, WifiOff, Shield, ShieldAlert, Zap, TrendingUp,
  AlertTriangle, Clock, X, Download, Bell, ChevronDown, ChevronUp, LayoutGrid,
} from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'
import { getDailyLimitForDay } from '@/lib/warmup-engine'
import type { DelayPreset } from '@/lib/warmup-engine'
import {
  healthScore, healthColor, healthLabel, fmtPhone, timeAgo,
  STATUS_CFG, STRATEGIES, PRESET_BADGE, PRESET_LABEL, exportWarmupCSV,
  banRiskScore, banRiskLabel, banRiskCls,
} from '@/lib/warmup-ui'
import type { HealthResult }   from '@/lib/services/warming/health-calculator.service'
import type { ScheduleResult } from '@/lib/services/warming/daily-quota-calculator.service'
import type { OrchestrationResult } from '@/lib/services/warming/warming-orchestrator.service'

interface EnrichedPlanLine {
  lineId:        string
  phone_number:  string
  instance_name: string | null
  display_name:  string | null
  weight:        number
  health:        { score: number; label: string }
  schedule:      { dailyQuota: number; remainingToday: number; shouldSendToday: boolean }
}
import { WarmupLineDetail }    from '@/components/warmup/WarmupLineDetail'
import { WarmupStats }         from '@/components/warmup/WarmupStats'
import { WarmupMetrics }       from '@/components/warmup/WarmupMetrics'
import { BulkActions }         from '@/components/warmup/BulkActions'
import { WarmupToastStack, useWarmupToasts } from '@/components/warmup/WarmupToast'
import { WarmupIntelligence }  from '@/components/warmup/WarmupIntelligence'
import { useWarmupRealtime }      from '@/hooks/useWarmupRealtime'
import { useDesktopNotifications } from '@/hooks/useDesktopNotifications'

interface WarmupNumber {
  id: string
  phone_number: string
  instance_name: string
  display_name: string | null
  warmup_status: 'active' | 'paused' | 'completed' | 'banned'
  current_day: number
  target_days: number
  messages_sent_today: number
  total_messages_sent: number
  daily_limit: number
  last_message_at: string | null
  notes: string | null
  delay_preset: DelayPreset
  anti_ban_enabled: boolean | null
  // Fase 1.5: persistido por POST /api/warmup/schedule
  health_score?: number
  health_updated_at?: string | null
  // Fase 1.5: populado desde GET /api/warmup/[id]/health al abrir detalle
  assignedQuotaToday?: number
  remainingToday?: number
}

/**
 * Devuelve el score de salud almacenado (DB) si existe,
 * o lo estima con la fórmula legada de warmup-ui.
 */
function resolveScore(n: WarmupNumber): number {
  return n.health_score ?? healthScore(n)
}

/** true cuando el score proviene de la DB; false cuando es estimado localmente. */
function scoreIsFromDB(n: WarmupNumber): boolean {
  return n.health_score !== undefined && n.health_score !== null
}

type QrState = 'idle' | 'loading' | 'not-found' | 'creating' | 'qr' | 'connected' | 'error'

const EVO_MANAGER = process.env.NEXT_PUBLIC_EVOLUTION_MANAGER_URL ?? ''

// ── SSE status dot ─────────────────────────────────────────────────────────────
const STATUS_DOT: Record<string, string> = {
  connected:    'bg-green-400 animate-pulse',
  connecting:   'bg-amber-400',
  disconnected: 'bg-gray-400',
}

export default function WarmupPage() {
  const [numbers, setNumbers] = useState<WarmupNumber[]>([])
  const [loading, setLoading] = useState(false)

  // Add modal
  const [showAdd, setShowAdd]             = useState(false)
  const [addName, setAddName]             = useState('')
  const [addPhone, setAddPhone]           = useState('')
  const [addInstance, setAddInstance]     = useState('')
  const [addStrategy, setAddStrategy]     = useState<DelayPreset>('normal')
  const [addDays, setAddDays]             = useState('21')
  const [addLimit, setAddLimit]           = useState('10')
  const [showAdvanced, setShowAdvanced]   = useState(false)
  const [addSaving, setAddSaving]         = useState(false)
  const [addError, setAddError]           = useState('')
  const [addPhase, setAddPhase]           = useState<'form' | 'qr' | 'saving'>('form')
  const [addQrBase64, setAddQrBase64]     = useState<string | null>(null)
  const [addQrInstance, setAddQrInstance] = useState('')
  const [addQrError, setAddQrError]       = useState('')
  const [showManualPhone, setShowManualPhone] = useState(false)
  const addQrPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Inline name edit
  const [editingId, setEditingId]       = useState<string | null>(null)
  const [editingName, setEditingName]   = useState('')
  const [savingNameId, setSavingNameId] = useState<string | null>(null)
  const [savedNameId, setSavedNameId]   = useState<string | null>(null)

  // Detail modal
  const [detailId,  setDetailId]  = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<'overview' | 'config' | 'activity'>('overview')

  // Migrate confirm
  const [migratingId, setMigratingId]   = useState<string | null>(null)
  const [migrateError, setMigrateError] = useState('')

  // QR modal
  const [qrFor, setQrFor]       = useState<WarmupNumber | null>(null)
  const [qrState, setQrState]   = useState<QrState>('idle')
  const [qrBase64, setQrBase64] = useState<string | null>(null)
  const [qrError, setQrError]   = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fase 1.5: health detail para el modal de detalle
  const [lineHealthData, setLineHealthData] = useState<{
    health: HealthResult; schedule: ScheduleResult
  } | null>(null)
  // Garantiza que POST /api/warmup/schedule solo se llame una vez por mount
  const healthSyncedRef = useRef(false)

  // Fase 2: plan de distribución del día
  const [showPlan,    setShowPlan]    = useState(false)
  const [planData,    setPlanData]    = useState<{ plan: Omit<OrchestrationResult, 'lines'> & { lines: EnrichedPlanLine[] }; generatedAt: string } | null>(null)
  const [planLoading, setPlanLoading] = useState(false)

  // Warmup contacts
  const [wContacts,         setWContacts]         = useState<{ id: string; phone_number: string; is_active: boolean; message_count: number }[]>([])
  const [showContacts,      setShowContacts]      = useState(false)
  const [contactsInput,     setContactsInput]     = useState('')
  const [contactsSaving,    setContactsSaving]    = useState(false)
  const [contactsError,     setContactsError]     = useState('')
  const [contactsLoaded,    setContactsLoaded]    = useState(false)

  const loadContacts = useCallback(async () => {
    const d = await fetchJson<{ contacts: typeof wContacts }>('/api/warmup/contacts').catch(() => ({ contacts: [] }))
    setWContacts(d.contacts || [])
    setContactsLoaded(true)
  }, [])

  const addContacts = async () => {
    setContactsError('')
    const nums = contactsInput.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)
    if (nums.length === 0) return
    setContactsSaving(true)
    const r = await fetchJson<{ ok: boolean; added: number; error?: string }>(
      '/api/warmup/contacts', { method: 'POST', body: JSON.stringify({ phone_numbers: nums }) }
    ).catch(e => ({ ok: false, added: 0, error: e.message }))
    setContactsSaving(false)
    if (!r.ok) { setContactsError(r.error || 'Error al guardar'); return }
    setContactsInput('')
    loadContacts()
  }

  const deleteContact = async (id: string) => {
    await fetchJson(`/api/warmup/contacts/${id}`, { method: 'DELETE' }).catch(() => null)
    setWContacts(prev => prev.filter(c => c.id !== id))
  }

  // ── Phase 3: bulk selection ────────────────────────────────────────────────
  const [selected,             setSelected]             = useState<Set<string>>(new Set())
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set())
  const prevNumbersRef = useRef<WarmupNumber[]>([])

  // ── Phase 3: notifications ─────────────────────────────────────────────────
  const { toasts, push: pushToast, dismiss: dismissToast } = useWarmupToasts()
  const { notify: desktopNotify, permission: notifPerm, request: requestNotif } = useDesktopNotifications()

  const load = useCallback(async () => {
    setLoading(true)
    const d = await fetchJson<{ numbers: WarmupNumber[] }>('/api/warmup').catch(() => ({ numbers: [] }))
    setNumbers(d.numbers || [])
    setLoading(false)

    // Recalcula y persiste health scores una sola vez por montaje de página.
    // Fire-and-forget: no bloquea la UI; actualiza el estado cuando termina.
    if (!healthSyncedRef.current) {
      healthSyncedRef.current = true
      fetchJson<{ summary: Array<{ id: string; health_score: number }> }>(
        '/api/warmup/schedule',
        { method: 'POST' },
      )
        .then(result => {
          if (!result?.summary) return
          setNumbers(prev => prev.map(n => {
            const entry = result.summary.find(s => s.id === n.id)
            return entry ? { ...n, health_score: entry.health_score } : n
          }))
        })
        .catch(() => { /* falla silenciosa — no crítico para la UI */ })
    }
  }, []) // healthSyncedRef es un ref; no necesita estar en deps

  // ── Phase 3: SSE handler ───────────────────────────────────────────────────
  const handleSSENumbers = useCallback((rawNums: unknown[]) => {
    const nums = rawNums as WarmupNumber[]
    const prev = prevNumbersRef.current

    if (prev.length > 0) {
      for (const n of nums) {
        const p = prev.find(x => x.id === n.id)
        if (!p) continue
        const ns = resolveScore(n)
        const ps = resolveScore(p)
        const label = n.display_name || n.instance_name

        if (ps >= 40 && ns < 40 && n.warmup_status !== 'banned') {
          pushToast('critical', `Salud crítica: ${label}`, `Score ${ns}/100 — considerá pausar`)
          desktopNotify('Salud crítica en warmup', `${label}: score ${ns}/100`)
        }
        if (p.warmup_status !== 'completed' && n.warmup_status === 'completed') {
          pushToast('success', '¡Calentamiento completado!', label)
          desktopNotify('Calentamiento completado', label)
        }
        if (p.warmup_status !== 'banned' && n.warmup_status === 'banned') {
          pushToast('critical', `Línea baneada: ${label}`, 'Revisá la instancia en Evolution')
          desktopNotify('Línea baneada', label)
        }
      }
    }

    prevNumbersRef.current = nums
    setNumbers(nums)
  }, [pushToast, desktopNotify])

  const rtStatus = useWarmupRealtime(handleSSENumbers)

  useEffect(() => { load() }, [load])
  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current)
    if (addQrPollRef.current) clearInterval(addQrPollRef.current)
  }, [])

  // ── Phase 3: automation suggestions ───────────────────────────────────────
  const suggestions = useMemo(() => {
    const result: { key: string; msg: string; line: WarmupNumber }[] = []
    for (const n of numbers) {
      if (n.warmup_status === 'active' && n.last_message_at) {
        const days = (Date.now() - new Date(n.last_message_at).getTime()) / 86_400_000
        if (days >= 4)
          result.push({
            key: `idle-${n.id}`,
            msg: `${n.display_name || n.instance_name} lleva ${Math.floor(days)} días sin actividad`,
            line: n,
          })
      }
      const sc = resolveScore(n)
      if (sc < 30 && n.warmup_status === 'active')
        result.push({
          key: `health-${n.id}`,
          msg: `${n.display_name || n.instance_name} tiene salud muy baja (${sc}/100)`,
          line: n,
        })
      const risk = banRiskScore(n)
      if (risk >= 70 && !n.anti_ban_enabled && n.warmup_status === 'active')
        result.push({
          key: `banrisk-${n.id}`,
          msg: `${n.display_name || n.instance_name} tiene riesgo de ban alto (${risk}/100) — activá la protección anti-ban`,
          line: n,
        })
    }
    return result.filter(s => !dismissedSuggestions.has(s.key)).slice(0, 3)
  }, [numbers, dismissedSuggestions])

  // ── Stats ──────────────────────────────────────────────────────────────────
  const active    = numbers.filter(n => n.warmup_status === 'active').length
  const paused    = numbers.filter(n => n.warmup_status === 'paused').length
  const completed = numbers.filter(n => n.warmup_status === 'completed').length
  const banned    = numbers.filter(n => n.warmup_status === 'banned').length
  const totalToday = numbers.reduce((s, n) => s + n.messages_sent_today, 0)

  // ── Strategy helpers ───────────────────────────────────────────────────────
  const applyStrategy = (key: DelayPreset) => {
    setAddStrategy(key)
    const s = STRATEGIES.find(s => s.key === key)!
    setAddDays(String(s.targetDays))
    setAddLimit(String(s.dailyLimit))
  }

  // ── Phase 3: bulk selection helpers ───────────────────────────────────────
  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setSelected(prev => {
      const s = new Set(prev)
      s.has(id) ? s.delete(id) : s.add(id)
      return s
    })
  }

  const toggleSelectAll = () => {
    setSelected(prev =>
      prev.size === numbers.length ? new Set() : new Set(numbers.map(n => n.id))
    )
  }

  // ── Phase 3: bulk action handlers ─────────────────────────────────────────
  const bulkPatch = async (ids: string[], body: Record<string, unknown>) => {
    await Promise.all(ids.map(id =>
      fetch(`/api/warmup/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    ))
    setSelected(new Set())
    load()
  }

  const bulkPause    = (ids: string[]) => bulkPatch(ids, { warmup_status: 'paused' })
  const bulkResume   = (ids: string[]) => bulkPatch(ids, { warmup_status: 'active' })
  const bulkStrategy = async (ids: string[], preset: DelayPreset) => {
    const s = STRATEGIES.find(s => s.key === preset)!
    await bulkPatch(ids, { delay_preset: preset, target_days: s.targetDays, daily_limit: s.dailyLimit })
  }

  const bulkReset = async (ids: string[]) => {
    await Promise.all(ids.map(id => fetch(`/api/warmup/${id}/reset`, { method: 'POST' })))
    setSelected(new Set())
    load()
  }

  const handleExport = (ids: string[]) => {
    const toExport = ids.length > 0 ? numbers.filter(n => ids.includes(n.id)) : numbers
    exportWarmupCSV(toExport)
  }

  // ── Add modal ──────────────────────────────────────────────────────────────
  const stopAddPoll = () => {
    if (addQrPollRef.current) { clearInterval(addQrPollRef.current); addQrPollRef.current = null }
  }

  const openAdd = () => {
    setShowAdd(true); setAddError(''); setAddPhase('form')
    setAddName(''); setAddPhone(''); setAddInstance('')
    setAddStrategy('normal'); setAddDays('21'); setAddLimit('10')
    setShowAdvanced(false)
    setAddQrBase64(null); setAddQrInstance(''); setAddQrError('')
    setShowManualPhone(false)
  }

  const closeAdd = () => {
    stopAddPoll(); setShowAdd(false); setAddPhase('form')
    setAddQrBase64(null); setAddQrInstance(''); setAddQrError('')
    setAddName(''); setAddPhone(''); setAddInstance('')
    setShowManualPhone(false); setAddError('')
  }

  const generateAddQr = async () => {
    const instance = `warmup-${Date.now()}`
    setAddQrInstance(instance)
    setAddPhase('qr')
    setAddQrBase64(null)
    setAddQrError('')
    try {
      const res  = await fetch('/api/lines/qr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance }),
      })
      const data = await res.json()
      if (data.base64) {
        setAddQrBase64(data.base64)
        stopAddPoll()
        addQrPollRef.current = setInterval(() => pollAddQr(instance), 5000)
      } else {
        setAddQrError(data.error || 'No se pudo crear la instancia en Evolution')
        setAddPhase('form')
      }
    } catch {
      setAddQrError('Error de conexión con Evolution')
      setAddPhase('form')
    }
  }

  const pollAddQr = async (instance: string) => {
    try {
      const res  = await fetch(`/api/lines/qr?instance=${encodeURIComponent(instance)}`)
      const data = await res.json()
      if (data.connected) {
        stopAddPoll()
        if (data.phone_number) {
          await saveWarmupEntry(data.phone_number, instance)
        } else {
          setShowManualPhone(true)
          setAddQrError('Línea conectada. Ingresá el número para registrarla.')
        }
      } else if (data.base64) {
        setAddQrBase64(data.base64)
      }
    } catch { /* ignore */ }
  }

  const saveWarmupEntry = async (phone: string, instance: string) => {
    setAddPhase('saving')
    const res = await fetch('/api/warmup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone_number:  phone,
        instance_name: instance,
        display_name:  addName.trim() || undefined,
        target_days:   Number(addDays) || 21,
        daily_limit:   Number(addLimit) || 10,
        delay_preset:  addStrategy,
      }),
    })
    if (res.ok) {
      stopAddPoll(); setShowAdd(false); setAddPhase('form')
      await load()
    } else {
      const d = await res.json()
      setAddQrError(d.error || 'Error al guardar')
      setAddPhase('qr')
    }
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────
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
        target_days: Number(addDays) || 21,
        daily_limit: Number(addLimit) || 10,
        delay_preset: addStrategy,
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
      const newEntry: WarmupNumber = {
        id: '', phone_number: savedPhone, instance_name: savedInstance,
        display_name: savedName || null, warmup_status: 'active',
        current_day: 1, target_days: Number(addDays) || 21,
        messages_sent_today: 0, total_messages_sent: 0,
        daily_limit: Number(addLimit) || 10,
        last_message_at: null, notes: null, delay_preset: addStrategy,
        anti_ban_enabled: null,
      }
      openQr(newEntry)
    }
  }

  const saveName = async (id: string) => {
    setEditingId(null)
    setSavingNameId(id)
    await fetch(`/api/warmup/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: editingName.trim() || null }),
    })
    setSavingNameId(null)
    setSavedNameId(id)
    setTimeout(() => setSavedNameId(prev => prev === id ? null : prev), 1800)
    load()
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

  const openDetail = (n: WarmupNumber, tab: 'overview' | 'config' | 'activity' = 'overview') => {
    setDetailTab(tab)
    setDetailId(n.id)
    setLineHealthData(null)

    // Calcula salud en tiempo real al abrir el detalle; actualiza también
    // el score visible en la tabla para esa línea.
    fetchJson<{ line_id: string; health: HealthResult; schedule: ScheduleResult }>(
      `/api/warmup/${n.id}/health`,
    )
      .then(data => {
        setLineHealthData(data)
        setNumbers(prev => prev.map(x =>
          x.id === n.id
            ? { ...x, health_score: data.health.score,
                assignedQuotaToday: data.schedule.assignedQuotaToday,
                remainingToday:     data.schedule.remainingToday }
            : x
        ))
      })
      .catch(() => { /* falla silenciosa */ })
  }

  const migrate = async () => {
    if (!migratingId) return
    setMigrateError('')
    const res = await fetch(`/api/warmup/${migratingId}/migrate`, { method: 'POST' })
    if (!res.ok) { const d = await res.json(); setMigrateError(d.error || 'Error al migrar'); return }
    setMigratingId(null); load()
  }

  // ── QR ─────────────────────────────────────────────────────────────────────
  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }

  const closeQr = () => {
    stopPoll(); setQrFor(null); setQrState('idle')
    setQrBase64(null); setQrError(null)
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
        body: JSON.stringify({ instance: qrFor.instance_name }),
      })
      const data = await res.json()
      if (res.status === 401) { setQrState('not-found'); setQrError('Sin permisos para crear instancias.'); return }
      if (res.status === 500 && data?.error === 'Evolution admin key not configured') {
        setQrState('not-found'); setQrError('El Global API Key de Evolution no está configurado.'); return
      }
      if (data.base64) {
        setQrBase64(data.base64); setQrState('qr'); stopPoll()
        pollRef.current = setInterval(() => fetchQr(qrFor.instance_name), 5000)
      } else { setQrError('Sin QR. Intentá "Obtener QR".'); setQrState('not-found') }
    } catch { setQrError('Error al crear la instancia'); setQrState('not-found') }
  }

  const loadPlan = async () => {
    setPlanLoading(true)
    const data = await fetchJson<{ plan: OrchestrationResult & { lines: EnrichedPlanLine[] }; generatedAt: string }>(
      '/api/warmup/orchestrator/plan',
    ).catch(() => null)
    setPlanData(data)
    setPlanLoading(false)
  }

  const migratingNumber = numbers.find(n => n.id === migratingId)

  return (
    <div className="space-y-5">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Flame size={20} className="text-orange-500" />
            Calentamiento de Líneas
            {/* SSE status dot */}
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[rtStatus] ?? 'bg-gray-400'}`}
              title={rtStatus === 'connected' ? 'En vivo' : rtStatus === 'connecting' ? 'Conectando…' : 'Sin conexión en tiempo real'}
            />
          </h1>
          <p className="text-sm text-gray-500">
            {numbers.length} líneas · {totalToday} mensajes enviados hoy
          </p>
        </div>
        <div className="flex gap-2 items-center">
          {/* Request desktop notifications if not yet granted */}
          {notifPerm === 'default' && (
            <Button variant="ghost" size="sm" onClick={requestNotif}
              className="text-gray-400 hover:text-gray-600 h-8 px-2" title="Activar notificaciones de escritorio">
              <Bell size={14} />
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => handleExport([])}
            className="text-xs h-8 px-3 text-gray-600">
            <Download size={13} className="mr-1.5" /> Exportar
          </Button>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </Button>
          <Button size="sm" className="bg-orange-500 hover:bg-orange-600" onClick={openAdd}>
            <Plus size={14} className="mr-1" /> Agregar línea
          </Button>
        </div>
      </div>

      {/* ── Stats cards ── */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2 mb-1">
              <Flame size={15} className="text-amber-500" />
              <p className="text-xs text-gray-500 font-medium">Calentando</p>
            </div>
            <p className="text-2xl font-bold text-amber-600">{active}</p>
            <p className="text-[11px] text-gray-400 mt-0.5">en proceso activo</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2 mb-1">
              <ShieldAlert size={15} className="text-orange-500" />
              <p className="text-xs text-gray-500 font-medium">En Riesgo</p>
            </div>
            <p className="text-2xl font-bold text-orange-600">{paused}</p>
            <p className="text-[11px] text-gray-400 mt-0.5">pausadas</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle size={15} className="text-green-500" />
              <p className="text-xs text-gray-500 font-medium">Saludables</p>
            </div>
            <p className="text-2xl font-bold text-green-600">{completed}</p>
            <p className="text-[11px] text-gray-400 mt-0.5">calentamiento completo</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2 mb-1">
              <AlertCircle size={15} className="text-red-500" />
              <p className="text-xs text-gray-500 font-medium">Baneadas</p>
            </div>
            <p className="text-2xl font-bold text-red-500">{banned}</p>
            <p className="text-[11px] text-gray-400 mt-0.5">fuera de servicio</p>
          </CardContent>
        </Card>
      </div>

      {/* ── Stats strip ── */}
      <WarmupStats numbers={numbers} />

      {/* ── Métricas avanzadas (collapsible) ── */}
      <WarmupMetrics numbers={numbers} />

      {/* ── Plan del día (Fase 2) ── */}
      <Card>
        <CardContent className="p-0">
          <button
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
            onClick={() => {
              const next = !showPlan
              setShowPlan(next)
              if (next && !planData) loadPlan()
            }}
          >
            <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
              <LayoutGrid size={14} className="text-amber-500" />
              Plan de distribución del día
              {planData && (
                <span className="text-xs font-normal text-gray-400 ml-1">
                  {planData.plan.totalActiveLines} líneas · {planData.plan.totalDailyQuota} msgs totales
                </span>
              )}
            </div>
            {showPlan ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
          </button>

          {showPlan && (
            <div className="border-t border-gray-100 px-4 pb-4 pt-3">
              {planLoading ? (
                <div className="flex items-center gap-2 py-4 text-gray-400 text-sm">
                  <Loader2 size={14} className="animate-spin" /> Calculando plan…
                </div>
              ) : !planData ? (
                <p className="text-sm text-gray-400 py-3">No se pudo cargar el plan.</p>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-3 mb-4 text-center">
                    <div className="bg-amber-50 rounded-lg p-2.5">
                      <p className="text-lg font-bold text-amber-700">{planData.plan.totalActiveLines}</p>
                      <p className="text-[11px] text-amber-600">Líneas activas</p>
                    </div>
                    <div className="bg-blue-50 rounded-lg p-2.5">
                      <p className="text-lg font-bold text-blue-700">{planData.plan.totalDailyQuota}</p>
                      <p className="text-[11px] text-blue-600">Cuota total del día</p>
                    </div>
                    <div className="bg-green-50 rounded-lg p-2.5">
                      <p className="text-lg font-bold text-green-700">{planData.plan.totalRemainingToday}</p>
                      <p className="text-[11px] text-green-600">Restantes hoy</p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {planData.plan.lines
                      .filter(r => r.schedule.shouldSendToday)
                      .sort((a, b) => b.weight - a.weight)
                      .map(r => {
                        const name    = r.display_name || r.instance_name || r.lineId
                        const pctBar  = Math.round(r.weight * 100)
                        const sent    = r.schedule.dailyQuota - r.schedule.remainingToday
                        const sentPct = r.schedule.dailyQuota > 0
                          ? Math.round((sent / r.schedule.dailyQuota) * 100)
                          : 0
                        return (
                          <div key={r.lineId} className="flex items-center gap-3">
                            <div className="w-28 text-[11px] text-gray-600 truncate shrink-0" title={name}>{name}</div>
                            <div className="flex-1 bg-gray-100 rounded-full h-1.5 relative">
                              <div
                                className="h-1.5 rounded-full bg-amber-400"
                                style={{ width: `${pctBar}%` }}
                              />
                            </div>
                            <div className="text-[11px] text-gray-500 w-12 text-right shrink-0">
                              {Math.round(r.weight * 100)}%
                            </div>
                            <div className="text-[11px] text-gray-400 w-20 text-right shrink-0">
                              {sent}/{r.schedule.dailyQuota}
                              <span className="text-gray-300 ml-1">({sentPct}%)</span>
                            </div>
                            <div className="text-[11px] shrink-0">
                              <span className={`font-medium ${r.health.score >= 70 ? 'text-green-600' : r.health.score >= 40 ? 'text-amber-600' : 'text-red-500'}`}>
                                {r.health.score}
                              </span>
                            </div>
                          </div>
                        )
                      })
                    }
                  </div>

                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
                    <p className="text-[11px] text-gray-400">
                      Generado {new Date(planData.generatedAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                    </p>
                    <button
                      className="text-[11px] text-amber-600 hover:text-amber-800 underline"
                      onClick={loadPlan}
                    >
                      Recalcular
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Inteligencia (Fase 3) ── */}
      <WarmupIntelligence onOpenLine={id => {
        const n = numbers.find(x => x.id === id)
        if (n) openDetail(n)
      }} />

      {/* ── Automation suggestions ── */}
      {suggestions.length > 0 && (
        <div className="space-y-2">
          {suggestions.map(s => (
            <div key={s.key}
              className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-3.5 py-2.5"
            >
              <AlertTriangle size={13} className="text-amber-600 shrink-0" />
              <span className="text-xs text-amber-800 flex-1">{s.msg}</span>
              {s.key.startsWith('banrisk-') ? (
                <Button size="sm" variant="outline"
                  className="h-6 px-2.5 text-[11px] border-amber-300 text-amber-700 hover:bg-amber-100"
                  onClick={() => {
                    openDetail(s.line, 'config')
                    setDismissedSuggestions(prev => new Set([...prev, s.key]))
                  }}>
                  Configurar
                </Button>
              ) : (
                <Button size="sm" variant="outline"
                  className="h-6 px-2.5 text-[11px] border-amber-300 text-amber-700 hover:bg-amber-100"
                  onClick={async () => {
                    await toggleStatus(s.line)
                    setDismissedSuggestions(prev => new Set([...prev, s.key]))
                  }}>
                  Pausar
                </Button>
              )}
              <button
                className="text-amber-400 hover:text-amber-600 transition-colors p-0.5"
                onClick={() => setDismissedSuggestions(prev => new Set([...prev, s.key]))}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Tabla ── */}
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                {/* Checkbox select-all */}
                <th className="w-10 pl-4 py-3">
                  <Checkbox
                    checked={numbers.length > 0 && selected.size === numbers.length}
                    onCheckedChange={toggleSelectAll}
                    aria-label="Seleccionar todas"
                  />
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Línea</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Estado</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Estrategia</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Progreso</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Hoy / Total</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Salud</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Última actividad</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {numbers.length === 0
                ? (
                  <tr><td colSpan={9}>
                    {loading
                      ? <p className="text-center py-12 text-gray-400">Cargando…</p>
                      : (
                        <div className="flex flex-col items-center gap-5 py-16 px-8">
                          <div className="w-16 h-16 bg-orange-50 rounded-full flex items-center justify-center">
                            <Flame size={30} className="text-orange-400" />
                          </div>
                          <div className="text-center max-w-sm">
                            <p className="font-semibold text-gray-800 text-base mb-1.5">Calentá tus líneas antes de enviar</p>
                            <p className="text-sm text-gray-400 mb-4">
                              El calentamiento prepara gradualmente un número nuevo para enviar mensajes masivos sin riesgo de ban.
                            </p>
                            <ul className="text-left space-y-2 mb-5">
                              {[
                                { icon: '🛡️', text: 'Evita bloqueos y bans de WhatsApp' },
                                { icon: '📈', text: 'Aumenta el límite diario de forma progresiva y orgánica' },
                                { icon: '✅', text: 'Líneas listas para campañas en 14–30 días' },
                              ].map(b => (
                                <li key={b.text} className="flex items-center gap-2.5 text-sm text-gray-500">
                                  <span className="text-base leading-none">{b.icon}</span>
                                  <span>{b.text}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                          <Button className="bg-orange-500 hover:bg-orange-600 px-5" onClick={openAdd}>
                            <Plus size={14} className="mr-2" /> Agregar primera línea
                          </Button>
                        </div>
                      )
                    }
                  </td></tr>
                )
                : numbers.map(n => {
                    const dayPct         = n.target_days ? Math.min((n.current_day / n.target_days) * 100, 100) : 0
                    const effectiveLimit = getDailyLimitForDay(n.current_day, n.target_days)
                    const score          = resolveScore(n)
                    const isComplete     = n.warmup_status === 'completed'
                    const label          = n.display_name || n.instance_name
                    const isEditing      = editingId === n.id
                    const cfg            = STATUS_CFG[n.warmup_status] ?? STATUS_CFG.active
                    const isSelected     = selected.has(n.id)

                    const rowAlerts: string[] = []
                    if (score < 40 && n.warmup_status !== 'banned') rowAlerts.push('Crítico')
                    if (n.warmup_status === 'active' && n.last_message_at) {
                      const idle = (Date.now() - new Date(n.last_message_at).getTime()) / 86_400_000
                      if (idle >= 3) rowAlerts.push('Inactiva')
                    }

                    return (
                      <tr
                        key={n.id}
                        className={`border-b border-gray-100 hover:bg-amber-50/30 cursor-pointer transition-colors ${
                          isSelected  ? 'bg-amber-50/60' :
                          isComplete  ? 'bg-green-50/20' : ''
                        }`}
                        onClick={() => openDetail(n)}
                      >
                        {/* Checkbox */}
                        <td className="pl-4 py-3 w-10" onClick={e => e.stopPropagation()}>
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => {
                              setSelected(prev => {
                                const s = new Set(prev)
                                s.has(n.id) ? s.delete(n.id) : s.add(n.id)
                                return s
                              })
                            }}
                            aria-label={`Seleccionar ${label}`}
                          />
                        </td>

                        {/* Línea: nombre + teléfono */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {n.warmup_status === 'active'
                              ? <Wifi size={13} className="text-amber-400 flex-shrink-0" />
                              : n.warmup_status === 'completed'
                              ? <Wifi size={13} className="text-green-500 flex-shrink-0" />
                              : <WifiOff size={13} className="text-gray-300 flex-shrink-0" />
                            }
                            <div>
                              {isEditing
                                ? (
                                  <form onSubmit={e => { e.preventDefault(); saveName(n.id) }} onClick={e => e.stopPropagation()} className="flex items-center gap-1">
                                    <Input
                                      autoFocus
                                      value={editingName}
                                      onChange={e => setEditingName(e.target.value)}
                                      onBlur={() => saveName(n.id)}
                                      onKeyDown={e => {
                                        if (e.key === 'Escape') { setEditingId(null); setEditingName('') }
                                      }}
                                      className="h-6 text-xs w-32 border-indigo-300 focus-visible:ring-indigo-400"
                                    />
                                  </form>
                                )
                                : (
                                  <div className="flex items-center gap-1.5 group">
                                    <button
                                      title="Clic para editar nombre"
                                      onClick={e => { e.stopPropagation(); setEditingId(n.id); setEditingName(n.display_name || n.instance_name) }}
                                      className="font-medium text-sm text-left hover:text-indigo-600 transition-colors"
                                    >
                                      {label}
                                    </button>
                                    {savingNameId === n.id && <Loader2 size={11} className="animate-spin text-gray-400 shrink-0" />}
                                    {savedNameId  === n.id && <CheckCircle size={11} className="text-green-500 shrink-0" />}
                                    {savingNameId !== n.id && savedNameId !== n.id && (
                                      <Pencil size={10} className="opacity-0 group-hover:opacity-40 transition-opacity text-gray-400 shrink-0" />
                                    )}
                                  </div>
                                )
                              }
                              <p className="text-[11px] text-gray-400 font-mono leading-tight">{fmtPhone(n.phone_number)}</p>
                            </div>
                          </div>
                        </td>

                        {/* Estado */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dotCls}`} />
                            <Badge className={`text-[11px] px-1.5 py-0 ${cfg.cls}`}>{cfg.label}</Badge>
                          </div>
                          {rowAlerts.map(a => (
                            <div key={a} className="flex items-center gap-1 mt-0.5">
                              {a === 'Crítico'  && <AlertTriangle size={9} className="text-red-500 shrink-0" />}
                              {a === 'Inactiva' && <Clock size={9} className="text-amber-600 shrink-0" />}
                              <span className={`text-[10px] font-medium ${a === 'Crítico' ? 'text-red-500' : 'text-amber-600'}`}>{a}</span>
                            </div>
                          ))}
                          {(() => {
                            const risk = banRiskScore(n)
                            if (risk < 40) return null
                            const rCls = banRiskCls(risk)
                            const score = resolveScore(n)
                            return (
                              <div
                                title={`Riesgo de ban: ${risk}/100 — Salud: ${score}/100${n.anti_ban_enabled ? ' · Protección anti-ban activa' : ' · Sin protección anti-ban'}`}
                                className={`flex items-center gap-1 mt-0.5 rounded px-1.5 py-0.5 w-fit cursor-help ${rCls.bg}`}
                              >
                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${rCls.dot}`} />
                                <span className={`text-[10px] font-medium ${rCls.text}`}>Ban {banRiskLabel(risk)}</span>
                                {n.anti_ban_enabled && (
                                  <Shield size={8} className={`${rCls.text} shrink-0 opacity-80`} />
                                )}
                              </div>
                            )
                          })()}
                        </td>

                        {/* Estrategia */}
                        <td className="px-4 py-3">
                          <Badge className={`text-[11px] px-1.5 py-0 ${PRESET_BADGE[n.delay_preset] || 'bg-gray-100 text-gray-500'}`}>
                            {PRESET_LABEL[n.delay_preset] || n.delay_preset}
                          </Badge>
                        </td>

                        {/* Progreso día */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-20 bg-gray-100 rounded-full h-1.5">
                              <div
                                className={`h-1.5 rounded-full ${isComplete ? 'bg-green-400' : 'bg-amber-400'}`}
                                style={{ width: `${dayPct}%` }}
                              />
                            </div>
                            <span className="text-[11px] text-gray-500 whitespace-nowrap">Día {n.current_day}/{n.target_days}</span>
                          </div>
                          <div className="text-[10px] text-gray-400 mt-0.5">{Math.round(dayPct)}% completado</div>
                        </td>

                        {/* Hoy / Total */}
                        <td className="px-4 py-3">
                          {(() => {
                            const quota     = n.assignedQuotaToday ?? effectiveLimit
                            const remaining = n.remainingToday      ?? Math.max(0, quota - n.messages_sent_today)
                            return (
                              <>
                                <div className="text-sm font-medium text-gray-700">
                                  {n.messages_sent_today}
                                  <span className="text-gray-400 font-normal">/{quota}</span>
                                </div>
                                <div className="text-[11px] text-gray-400">
                                  {remaining > 0
                                    ? <span className="text-amber-600 font-medium">{remaining} restantes</span>
                                    : <span>{n.total_messages_sent} total</span>
                                  }
                                </div>
                              </>
                            )
                          })()}
                        </td>

                        {/* Salud */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-14 bg-gray-100 rounded-full h-1.5">
                              <div
                                className={`h-1.5 rounded-full transition-all ${healthColor(score)}`}
                                style={{ width: `${score}%` }}
                              />
                            </div>
                            <span className="text-[11px] font-medium text-gray-600">{score}</span>
                            {!scoreIsFromDB(n) && (
                              <span
                                className="text-[9px] text-gray-300 font-normal leading-none"
                                title="Score estimado — aún no calculado por el scheduler"
                              >~</span>
                            )}
                          </div>
                          <div className="text-[10px] text-gray-400 mt-0.5">{healthLabel(score)}</div>
                        </td>

                        {/* Última actividad */}
                        <td className="px-4 py-3">
                          {(() => {
                            const { relative, abs } = timeAgo(n.last_message_at)
                            return n.last_message_at ? (
                              <div>
                                <span className="text-[11px] text-gray-600">{relative}</span>
                                <p className="text-[10px] text-gray-400 mt-0.5">{abs}</p>
                              </div>
                            ) : (
                              <span className="text-[11px] text-gray-400 italic">Nunca enviado</span>
                            )
                          })()}
                        </td>

                        {/* Acciones */}
                        <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center gap-1">
                            <Button size="sm" variant="outline"
                              className="text-[11px] border-orange-200 text-orange-700 hover:bg-orange-50 h-7 px-2"
                              onClick={() => openQr(n)}>
                              <QrCode size={11} className="mr-1" /> QR
                            </Button>

                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-gray-400"
                              title="Ver actividad"
                              onClick={() => openDetail(n, 'activity')}>
                              <TrendingUp size={12} />
                            </Button>

                            {(n.warmup_status === 'active' || n.warmup_status === 'paused') && (
                              <Button size="sm" variant="ghost"
                                className={`h-7 w-7 p-0 ${n.warmup_status === 'active' ? 'text-yellow-500' : 'text-green-600'}`}
                                title={n.warmup_status === 'active' ? 'Pausar' : 'Reanudar'}
                                onClick={() => toggleStatus(n)}>
                                {n.warmup_status === 'active' ? <Pause size={12} /> : <Play size={12} />}
                              </Button>
                            )}

                            {isComplete && (
                              <Button size="sm" variant="outline"
                                className="h-7 px-2 text-[11px] border-blue-200 text-blue-700 hover:bg-blue-50"
                                onClick={() => { setMigratingId(n.id); setMigrateError('') }}>
                                <ArrowRight size={11} className="mr-1" /> Mover
                              </Button>
                            )}

                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-400 hover:text-red-600"
                              title="Eliminar" onClick={() => deleteNumber(n.id)}>
                              <Trash2 size={12} />
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

      {/* ── Contactos de warmup ── */}
      <div className="mt-4">
        <button
          className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 font-medium"
          onClick={() => { setShowContacts(v => !v); if (!contactsLoaded) loadContacts() }}
        >
          <span className={`transition-transform ${showContacts ? 'rotate-180' : ''}`}><ChevronDown size={14} /></span>
          Contactos de calentamiento
          {wContacts.length > 0
            ? <span className="ml-1 text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full">{wContacts.length}</span>
            : <span className="ml-1 text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">0 — requerido para enviar</span>
          }
        </button>

        {showContacts && (
          <Card className="mt-2">
            <CardContent className="p-4 space-y-3">
              <p className="text-xs text-gray-500">
                Son los números que <em>reciben</em> los mensajes de prueba. Usá números propios o de confianza (formato E.164, ej: +5491112345678).
              </p>

              {/* Add form */}
              <div className="flex gap-2">
                <textarea
                  className="flex-1 text-xs border border-gray-200 rounded-md p-2 resize-none h-16 focus:outline-none focus:ring-1 focus:ring-orange-400"
                  placeholder={"+5491112345678\n+5491187654321\n(uno por línea o separados por coma)"}
                  value={contactsInput}
                  onChange={e => setContactsInput(e.target.value)}
                />
                <Button
                  size="sm"
                  className="bg-orange-500 hover:bg-orange-600 self-start"
                  disabled={contactsSaving || !contactsInput.trim()}
                  onClick={addContacts}
                >
                  {contactsSaving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  <span className="ml-1">Agregar</span>
                </Button>
              </div>
              {contactsError && <p className="text-xs text-red-600">{contactsError}</p>}

              {/* List */}
              {wContacts.length > 0 && (
                <div className="border border-gray-100 rounded-md overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-100">
                        <th className="text-left px-3 py-2 font-medium text-gray-500">Número</th>
                        <th className="text-right px-3 py-2 font-medium text-gray-500">Usos</th>
                        <th className="w-8 px-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {wContacts.map(c => (
                        <tr key={c.id} className="border-b border-gray-50 last:border-0">
                          <td className="px-3 py-1.5 font-mono text-gray-700">{c.phone_number}</td>
                          <td className="px-3 py-1.5 text-right text-gray-400">{c.message_count}</td>
                          <td className="px-2 py-1.5 text-right">
                            <button onClick={() => deleteContact(c.id)} className="text-gray-300 hover:text-red-500 transition-colors">
                              <Trash2 size={12} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {wContacts.length === 0 && contactsLoaded && (
                <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                  Sin contactos de calentamiento → el procesador no puede enviar mensajes. Agregá al menos un número arriba.
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* ── Modal agregar ── */}
      <Dialog open={showAdd} onOpenChange={open => { if (!open) closeAdd() }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Flame size={16} className="text-orange-500" /> Agregar línea al calentamiento
            </DialogTitle>
          </DialogHeader>

          {addPhase === 'form' && (
            <div className="space-y-4 pt-1">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Nombre para mostrar</label>
                <Input placeholder="Ej: Línea Betcoin 01" value={addName} onChange={e => setAddName(e.target.value)} />
              </div>

              <div>
                <label className="text-xs text-gray-500 mb-1.5 block flex items-center gap-1">
                  <TrendingUp size={11} /> Estrategia de calentamiento
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {STRATEGIES.map(s => (
                    <button key={s.key} type="button" onClick={() => applyStrategy(s.key)}
                      className={`rounded-lg border-2 px-3 py-2.5 text-left transition-all ${
                        addStrategy === s.key ? s.cls + ' border-current' : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
                      }`}>
                      <div className="flex items-center gap-1 mb-0.5">
                        {s.key === 'agresiva' && <Zap size={11} />}
                        <span className="font-semibold text-xs">{s.label}</span>
                      </div>
                      <p className="text-[10px] leading-tight opacity-80">{s.desc}</p>
                      <p className="text-[10px] mt-1 opacity-60">{s.targetDays}d · {s.dailyLimit} msg/día</p>
                    </button>
                  ))}
                </div>
              </div>

              <button type="button" onClick={() => setShowAdvanced(v => !v)}
                className="text-[11px] text-gray-400 hover:text-gray-600 underline">
                {showAdvanced ? 'Ocultar' : 'Ajuste fino'} de días y límite diario
              </button>

              {showAdvanced && (
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
              )}

              {showManualPhone ? (
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Número de teléfono *</label>
                  <Input
                    placeholder="+5492235042625"
                    value={addPhone}
                    onChange={e => {
                      const raw = e.target.value
                      const val = raw.startsWith('+') ? '+' + raw.slice(1).replace(/\D/g, '') : raw.replace(/\D/g, '')
                      setAddPhone(val)
                      const digits = val.replace(/\D/g, '')
                      if (digits) setAddInstance(`warmup-${digits}`)
                      else setAddInstance('')
                    }}
                    className="font-mono text-sm"
                  />
                  {addInstance && (
                    <p className="text-xs text-gray-400 mt-1">Instancia: <span className="font-mono text-gray-600">{addInstance}</span></p>
                  )}
                </div>
              ) : (
                <button type="button" className="text-xs text-gray-400 hover:text-gray-600 underline"
                  onClick={() => setShowManualPhone(true)}>
                  Tengo el número de teléfono (ingreso manual)
                </button>
              )}

              {addError && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">{addError}</p>}

              <div className="flex flex-col gap-2 pt-1">
                {!showManualPhone ? (
                  <Button className="w-full bg-orange-500 hover:bg-orange-600" onClick={generateAddQr}>
                    <QrCode size={14} className="mr-2" /> Generar QR y escanear
                  </Button>
                ) : (
                  <Button className="w-full bg-orange-500 hover:bg-orange-600"
                    onClick={() => addNumber(true)} disabled={addSaving || !addPhone}>
                    <QrCode size={14} className="mr-2" />
                    {addSaving ? 'Guardando…' : 'Agregar y vincular QR'}
                  </Button>
                )}
                <Button variant="ghost" className="w-full text-gray-500" onClick={closeAdd}>Cancelar</Button>
              </div>
            </div>
          )}

          {addPhase === 'qr' && (
            <div className="flex flex-col items-center gap-4 py-2">
              {!addQrBase64 && !showManualPhone && (
                <div className="flex flex-col items-center gap-3 py-8">
                  <Loader2 size={32} className="animate-spin text-orange-400" />
                  <p className="text-sm text-gray-500">Generando QR…</p>
                </div>
              )}
              {addQrBase64 && !showManualPhone && (
                <>
                  <div className="border-4 border-gray-200 rounded-xl p-2 bg-white">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={addQrBase64.startsWith('data:') ? addQrBase64 : `data:image/png;base64,${addQrBase64}`}
                      alt="QR WhatsApp" className="w-56 h-56 object-contain" />
                  </div>
                  <div className="text-center space-y-1">
                    <p className="text-sm font-medium">Escaneá con WhatsApp</p>
                    <p className="text-xs text-gray-400">WhatsApp → Dispositivos vinculados → Vincular un dispositivo</p>
                    <p className="text-xs text-orange-500 flex items-center justify-center gap-1 mt-2">
                      <Loader2 size={11} className="animate-spin" /> Esperando escaneo…
                    </p>
                  </div>
                </>
              )}
              {showManualPhone && (
                <div className="w-full space-y-3">
                  <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700 flex items-center gap-2">
                    <CheckCircle size={16} /> Línea conectada
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Número de teléfono *</label>
                    <Input placeholder="+5492235042625" value={addPhone}
                      onChange={e => {
                        const raw = e.target.value
                        setAddPhone(raw.startsWith('+') ? '+' + raw.slice(1).replace(/\D/g, '') : raw.replace(/\D/g, ''))
                      }}
                      className="font-mono text-sm" autoFocus />
                  </div>
                  <Button className="w-full bg-orange-500 hover:bg-orange-600"
                    disabled={!addPhone} onClick={() => saveWarmupEntry(addPhone, addQrInstance)}>
                    Guardar
                  </Button>
                </div>
              )}
              {addQrError && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2 w-full">{addQrError}</p>}
              <Button variant="ghost" className="w-full text-gray-500 text-xs" onClick={closeAdd}>Cancelar</Button>
            </div>
          )}

          {addPhase === 'saving' && (
            <div className="flex flex-col items-center gap-3 py-10">
              <Loader2 size={32} className="animate-spin text-orange-400" />
              <p className="text-sm text-gray-600">Registrando línea…</p>
            </div>
          )}
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
                  <p className="text-xs font-medium text-gray-700">Crear instancia automáticamente</p>
                  <Button className="w-full bg-orange-500 hover:bg-orange-600 text-sm" onClick={createInstance}>
                    Crear instancia y obtener QR
                  </Button>
                </div>
                <div className="border rounded-lg p-4 space-y-2">
                  <p className="text-xs font-medium text-gray-700">O creala manualmente en Evolution</p>
                  <div className="flex gap-2">
                    {EVO_MANAGER && (
                      <a href={EVO_MANAGER} target="_blank" rel="noreferrer" className="flex-1">
                        <Button variant="outline" size="sm" className="w-full text-xs">
                          <ExternalLink size={12} className="mr-1" /> Evolution Manager
                        </Button>
                      </a>
                    )}
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

      {/* ── Modal detalle ── */}
      <WarmupLineDetail
        lineId={detailId}
        defaultTab={detailTab}
        onClose={() => setDetailId(null)}
        onRefresh={load}
        healthData={lineHealthData ?? undefined}
      />

      {/* ── Phase 3: Bulk actions floating toolbar ── */}
      <BulkActions
        selected={selected}
        numbers={numbers}
        onClear={() => setSelected(new Set())}
        onPause={bulkPause}
        onResume={bulkResume}
        onReset={bulkReset}
        onStrategy={bulkStrategy}
        onExport={handleExport}
      />

      {/* ── Phase 3: Toast notifications ── */}
      <WarmupToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
