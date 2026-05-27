'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import { useCurrentUser } from '@/lib/useCurrentUser'

// ── Tipos ─────────────────────────────────────────────────────────────────────

type ScoringConfigKey =
  | 'urgency_score_max'
  | 'risk_weight_daily'
  | 'risk_weight_weekly'
  | 'risk_weight_cooldown'
  | 'allow_threshold'
  | 'delay_threshold'
  | 'cooldown_multiplier'

type ScoringConfig = Record<ScoringConfigKey, number>

const CRITICAL_KEYS: ScoringConfigKey[] = ['allow_threshold', 'delay_threshold']

// ── Toast ─────────────────────────────────────────────────────────────────────

type ToastItem = { id: number; type: 'success' | 'error'; msg: string }

function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const counter = useRef(0)
  const show = useCallback((type: 'success' | 'error', msg: string) => {
    const id = ++counter.current
    setToasts(prev => [...prev, { id, type, msg }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4500)
  }, [])
  return { toasts, success: (m: string) => show('success', m), error: (m: string) => show('error', m) }
}

function ToastStack({ toasts }: { toasts: ToastItem[] }) {
  if (!toasts.length) return null
  return (
    <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div key={t.id} className={`px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium text-white pointer-events-auto ${t.type === 'success' ? 'bg-green-600' : 'bg-red-600'}`}>
          {t.msg}
        </div>
      ))}
    </div>
  )
}

// ── Validación local (espejo del backend) ─────────────────────────────────────

function validate(draft: Partial<ScoringConfig>): string[] {
  const errors: string[] = []
  if (draft.urgency_score_max !== undefined && (draft.urgency_score_max < 1 || draft.urgency_score_max > 100))
    errors.push('urgency_score_max debe estar entre 1 y 100')

  const d = draft.risk_weight_daily
  const w = draft.risk_weight_weekly
  const c = draft.risk_weight_cooldown
  if (d !== undefined && w !== undefined && c !== undefined && d + w + c !== 100)
    errors.push('La suma de pesos debe ser exactamente 100')

  if (draft.allow_threshold !== undefined && draft.allow_threshold < 0)
    errors.push('allow_threshold debe ser ≥ 0')
  if (draft.delay_threshold !== undefined && draft.delay_threshold > 100)
    errors.push('delay_threshold debe ser ≤ 100')
  if (draft.allow_threshold !== undefined && draft.delay_threshold !== undefined && draft.allow_threshold >= draft.delay_threshold)
    errors.push('allow_threshold debe ser < delay_threshold')
  if (draft.cooldown_multiplier !== undefined && draft.cooldown_multiplier < 1)
    errors.push('cooldown_multiplier debe ser ≥ 1')
  return errors
}

// ── Componente principal ──────────────────────────────────────────────────────

export function ScoringTab() {
  const { user } = useCurrentUser()
  const isAdmin = user?.role === 'admin'
  const toast = useToast()

  const [config, setConfig]           = useState<ScoringConfig | null>(null)
  const [configUpdatedAt, setConfigUpdatedAt] = useState<string | null>(null)
  const [draft, setDraft]             = useState<ScoringConfig | null>(null)
  const [loading, setLoading]         = useState(true)
  const [fetchError, setFetchError]   = useState<string | null>(null)
  const [validationErrors, setValidationErrors] = useState<string[]>([])
  const [saving, setSaving]           = useState(false)
  const [showModal, setShowModal]     = useState(false)
  const [reason, setReason]           = useState('')

  // ── Fetch inicial ────────────────────────────────────────────────────────────

  const fetchConfig = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const res = await fetch('/api/settings/scoring')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { config: ScoringConfig; config_updated_at: string | null }
      setConfig(data.config)
      setDraft(data.config)
      setConfigUpdatedAt(data.config_updated_at)
    } catch {
      setFetchError('Error al cargar la configuración del motor de scoring')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void fetchConfig() }, [fetchConfig])

  // Revalidar al cambiar draft
  useEffect(() => {
    if (!draft) return
    setValidationErrors(validate(draft))
  }, [draft])

  if (loading) return (
    <div className="flex items-center justify-center h-32">
      <Loader2 size={20} className="animate-spin text-gray-400" />
    </div>
  )

  if (fetchError || !config || !draft) return (
    <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
      <AlertCircle size={16} className="shrink-0" /> {fetchError ?? 'Error al cargar'}
    </div>
  )

  // ── Helpers de draft ─────────────────────────────────────────────────────────
  // Asignación no-nula después del guard `!draft` de arriba.
  // TypeScript no estrecha closures de funciones internas, así que capturamos aquí.
  const safeDraft = draft

  const weightsSum = (safeDraft.risk_weight_daily ?? 0) + (safeDraft.risk_weight_weekly ?? 0) + (safeDraft.risk_weight_cooldown ?? 0)
  const hasCriticalChange = CRITICAL_KEYS.some(k => safeDraft[k] !== config[k])
  const hasAnyChange = (Object.keys(safeDraft) as ScoringConfigKey[]).some(k => safeDraft[k] !== config[k])
  const canSave = hasAnyChange && validationErrors.length === 0

  function numInput(key: ScoringConfigKey, min: number, max: number, step = 1) {
    return (
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={safeDraft[key] ?? ''}
        disabled={!isAdmin}
        onChange={e => setDraft(prev => prev ? { ...prev, [key]: Number(e.target.value) } : prev)}
        className="h-8 text-sm w-24"
      />
    )
  }

  // ── Guardar ──────────────────────────────────────────────────────────────────

  function handleSaveClick() {
    if (!canSave) return
    const errors = validate(safeDraft)
    if (errors.length) { setValidationErrors(errors); return }
    if (hasCriticalChange) {
      setReason('')
      setShowModal(true)
    } else {
      void doSave()
    }
  }

  async function doSave(withReason?: string) {
    if (!draft || !config || !configUpdatedAt) return
    setSaving(true)
    try {
      const changes: Partial<Record<ScoringConfigKey, number>> = {}
      for (const k of Object.keys(draft) as ScoringConfigKey[]) {
        if (draft[k] !== config[k]) changes[k] = draft[k]
      }

      const res = await fetch('/api/settings/scoring', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes, reason: withReason, updated_at: configUpdatedAt }),
      })
      const data = await res.json() as { ok?: boolean; error?: string; config?: ScoringConfig; impact_note?: string }

      if (res.status === 409) {
        toast.error(data.error ?? 'Conflicto de concurrencia. Recargando datos...')
        await fetchConfig()
        setShowModal(false)
        return
      }
      if (!res.ok) {
        toast.error(data.error ?? `Error ${res.status}`)
        return
      }
      if (data.config) {
        const updatedConfig = data.config as ScoringConfig
        setConfig(updatedConfig)
        setDraft(updatedConfig)
      }
      await fetchConfig() // refresca config_updated_at también
      toast.success('Configuración guardada correctamente.')
      setShowModal(false)
    } catch {
      toast.error('Error de red al guardar')
    } finally {
      setSaving(false)
    }
  }

  // ── Visualización de rangos ALLOW/DELAY/BLOCK ────────────────────────────────

  const allowPct  = Math.max(0, Math.min(100, draft.allow_threshold))
  const delayPct  = Math.max(0, Math.min(100, draft.delay_threshold))
  const blockPct  = 100 - delayPct

  return (
    <>
      <ToastStack toasts={toast.toasts} />

      {/* Banner */}
      <div className="flex items-start gap-2 bg-orange-50 border border-orange-200 rounded-lg px-4 py-3 text-sm text-orange-800 mb-4">
        <AlertTriangle size={16} className="shrink-0 mt-0.5" />
        <span>Cambios en umbrales (allow/delay) afectan decisiones de envío de forma inmediata.</span>
      </div>

      <div className="space-y-4">

        {/* ── Sección 1: Pesos del Risk Score ────────────────────────────── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Pesos del Risk Score</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-gray-500">
              Distribución de los 100 puntos entre los tres componentes del risk score.
              La suma debe ser exactamente 100.
            </p>

            <div className="grid grid-cols-3 gap-4">
              {([
                { key: 'risk_weight_daily'    as const, label: 'Peso diario' },
                { key: 'risk_weight_weekly'   as const, label: 'Peso semanal' },
                { key: 'risk_weight_cooldown' as const, label: 'Peso cooldown' },
              ] as const).map(({ key, label }) => (
                <div key={key} className="space-y-1">
                  <label className="text-xs font-medium text-gray-600">{label}</label>
                  {numInput(key, 0, 100)}
                </div>
              ))}
            </div>

            <div className={`text-sm font-medium ${weightsSum === 100 ? 'text-green-600' : 'text-red-600'}`}>
              Suma actual: {weightsSum} / 100
              {weightsSum !== 100 && <span className="ml-2 text-xs font-normal">← debe ser exactamente 100</span>}
            </div>

            {/* ── Otros escalares ─────────────────────────────────────────── */}
            <div className="grid grid-cols-2 gap-4 pt-2 border-t border-gray-50">
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-600">Score máx urgencia</label>
                <p className="text-xs text-gray-400">Multiplicador en scoreUrgency()</p>
                {numInput('urgency_score_max', 1, 100)}
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-600">Multiplicador cooldown</label>
                <p className="text-xs text-gray-400">Ventana = min_hours × multiplicador</p>
                {numInput('cooldown_multiplier', 1, 10)}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── Sección 2: Umbrales de decisión ────────────────────────────── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Umbrales de decisión
              <span className="ml-2 text-xs font-normal text-orange-500">(campos críticos *)</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-gray-500">
              El Risk Score (0–100) determina si se envía (ALLOW), retrasa (DELAY) o bloquea (BLOCK)
              cada mensaje.
            </p>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-600">
                  Allow threshold <span className="text-orange-400">*</span>
                </label>
                <p className="text-xs text-gray-400">Score ≤ este valor → ALLOW</p>
                {numInput('allow_threshold', 0, 100)}
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-600">
                  Delay threshold <span className="text-orange-400">*</span>
                </label>
                <p className="text-xs text-gray-400">Score ≤ este valor → DELAY (arriba → BLOCK)</p>
                {numInput('delay_threshold', 0, 100)}
              </div>
            </div>

            {/* Visualización de rangos en tiempo real */}
            <div className="space-y-2 pt-2">
              <div className="flex h-6 rounded-full overflow-hidden text-xs font-medium">
                <div
                  className="bg-green-500 flex items-center justify-center text-white"
                  style={{ width: `${allowPct}%` }}
                  title={`ALLOW (0–${allowPct})`}
                >
                  {allowPct >= 15 && 'ALLOW'}
                </div>
                <div
                  className="bg-yellow-400 flex items-center justify-center text-yellow-900"
                  style={{ width: `${Math.max(0, delayPct - allowPct)}%` }}
                  title={`DELAY (${allowPct}–${delayPct})`}
                >
                  {(delayPct - allowPct) >= 15 && 'DELAY'}
                </div>
                <div
                  className="bg-red-500 flex items-center justify-center text-white"
                  style={{ width: `${blockPct}%` }}
                  title={`BLOCK (${delayPct}–100)`}
                >
                  {blockPct >= 15 && 'BLOCK'}
                </div>
              </div>
              <div className="flex justify-between text-xs text-gray-400">
                <span>0</span>
                <span>{allowPct} — ALLOW</span>
                <span>{delayPct} — DELAY</span>
                <span>100 — BLOCK</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── Errores de validación y botón guardar ─────────────────────── */}
        {validationErrors.length > 0 && (
          <div className="space-y-1">
            {validationErrors.map((e, i) => (
              <div key={i} className="flex items-center gap-1 text-sm text-red-600">
                <AlertCircle size={13} /> {e}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3 pt-2">
          {isAdmin ? (
            <Button
              onClick={handleSaveClick}
              disabled={!canSave || saving}
            >
              {saving
                ? <><Loader2 size={13} className="animate-spin mr-1" />Guardando…</>
                : 'Guardar cambios'
              }
            </Button>
          ) : (
            <span className="text-xs text-gray-400">Solo los administradores pueden modificar estos valores.</span>
          )}
          {!hasAnyChange && !saving && (
            <span className="text-xs text-gray-400">Sin cambios pendientes</span>
          )}
        </div>
      </div>

      {/* Modal de confirmación para campos críticos */}
      <Dialog open={showModal} onOpenChange={open => { if (!open && !saving) setShowModal(false) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Confirmar cambio en umbrales</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 text-sm space-y-1">
              {CRITICAL_KEYS.filter(k => draft[k] !== config[k]).map(k => (
                <div key={k} className="flex items-center gap-2">
                  <span className="font-medium text-orange-800">{k}:</span>
                  <span className="line-through text-orange-400">{config[k]}</span>
                  <span className="text-orange-800 font-semibold">→ {draft[k]}</span>
                </div>
              ))}
              <p className="text-xs text-orange-600 mt-1">
                Estos cambios son efectivos de inmediato para nuevas evaluaciones del engine de frecuencia.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-700">
                Motivo del cambio <span className="text-red-500">*</span>
              </label>
              <Textarea
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="Describe el motivo del cambio (mín. 10 caracteres)"
                className="text-sm resize-none"
                rows={3}
              />
              <p className={`text-xs ${reason.trim().length < 10 ? 'text-gray-400' : 'text-green-600'}`}>
                {reason.trim().length}/10 caracteres mínimos
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { if (!saving) setShowModal(false) }}
              disabled={saving}
            >
              Cancelar
            </Button>
            <Button
              onClick={() => void doSave(reason.trim())}
              disabled={reason.trim().length < 10 || saving}
            >
              {saving
                ? <><Loader2 size={13} className="animate-spin mr-1" />Guardando…</>
                : <><CheckCircle2 size={13} className="mr-1" />Confirmar cambio</>
              }
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
