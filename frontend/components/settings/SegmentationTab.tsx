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

type TierName = 'vip' | 'alto' | 'medio' | 'bajo'

interface SegmentationTier {
  tier: TierName
  min_days_inactive: number
  max_days_inactive: number
  value_score: number
  deposit_threshold_min: number
  recontact_cooldown_days: number
  is_active: boolean
  workspace_id: string
  updated_at: string
}

type EditableField = 'min_days_inactive' | 'max_days_inactive' | 'value_score' | 'deposit_threshold_min' | 'recontact_cooldown_days'
const CRITICAL_FIELDS: EditableField[] = ['min_days_inactive', 'max_days_inactive', 'deposit_threshold_min']
const FIELD_LABELS: Record<EditableField, string> = {
  min_days_inactive:       'Inactividad mín',
  max_days_inactive:       'Inactividad máx',
  value_score:             'Score de valor',
  deposit_threshold_min:   'Depósito mín ($)',
  recontact_cooldown_days: 'Cooldown (días)',
}
const TIER_LABELS: Record<TierName, string> = { vip: 'VIP', alto: 'Alto', medio: 'Medio', bajo: 'Bajo' }
const TIER_COLORS: Record<TierName, string> = {
  vip:   'bg-yellow-50 text-yellow-800 font-semibold',
  alto:  'bg-blue-50 text-blue-800 font-semibold',
  medio: 'bg-gray-50 text-gray-700 font-medium',
  bajo:  'bg-gray-50 text-gray-400 font-medium',
}

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

function validateField(field: EditableField, value: number, tier: SegmentationTier): string | null {
  if (field === 'min_days_inactive') {
    if (value < 0) return 'Debe ser ≥ 0'
    if (value >= tier.max_days_inactive) return 'Debe ser < inactividad máx'
  }
  if (field === 'max_days_inactive') {
    if (value <= tier.min_days_inactive) return 'Debe ser > inactividad mín'
  }
  if (field === 'value_score') {
    if (value < 0 || value > 100) return 'Debe estar entre 0 y 100'
  }
  if (field === 'deposit_threshold_min') {
    if (value < 0) return 'Debe ser ≥ 0'
  }
  if (field === 'recontact_cooldown_days') {
    if (value < 1) return 'Debe ser ≥ 1'
  }
  return null
}

// ── Componente principal ──────────────────────────────────────────────────────

interface PendingCritical {
  tier: TierName
  field: EditableField
  oldValue: number
  newValue: number
  updatedAt: string
}

export function SegmentationTab() {
  const { user } = useCurrentUser()
  const isAdmin = user?.role === 'admin'
  const toast = useToast()

  const [tiers, setTiers]           = useState<SegmentationTier[]>([])
  const [loading, setLoading]       = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Estado de edición inline
  const [editCell, setEditCell]       = useState<{ tier: TierName; field: EditableField } | null>(null)
  const [editValue, setEditValue]     = useState<string>('')
  const [inlineError, setInlineError] = useState<string | null>(null)

  // Modal de confirmación para campos críticos
  const [pendingCritical, setPendingCritical] = useState<PendingCritical | null>(null)
  const [reason, setReason]   = useState('')
  const [saving, setSaving]   = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)

  // ── Fetch inicial ────────────────────────────────────────────────────────────

  const fetchTiers = useCallback(async () => {
    setLoading(true)
    setFetchError(null)
    try {
      const res = await fetch('/api/settings/segmentation')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { tiers: SegmentationTier[] }
      setTiers(data.tiers)
    } catch {
      setFetchError('Error al cargar la configuración de segmentación')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void fetchTiers() }, [fetchTiers])

  useEffect(() => {
    if (editCell) inputRef.current?.focus()
  }, [editCell])

  // ── Lógica de edición ────────────────────────────────────────────────────────

  function startEdit(tierName: TierName, field: EditableField, currentValue: number) {
    if (!isAdmin) return
    setEditCell({ tier: tierName, field })
    setEditValue(String(currentValue))
    setInlineError(null)
  }

  function cancelEdit() {
    setEditCell(null)
    setEditValue('')
    setInlineError(null)
  }

  function commitEdit() {
    if (!editCell) return
    const tierObj = tiers.find(t => t.tier === editCell.tier)
    if (!tierObj) return cancelEdit()

    const newValue = Number(editValue)
    if (isNaN(newValue)) { setInlineError('Valor inválido'); return }

    const err = validateField(editCell.field, newValue, tierObj)
    if (err) { setInlineError(err); return }

    const oldValue = tierObj[editCell.field] as number
    if (newValue === oldValue) { cancelEdit(); return }

    const isCritical = CRITICAL_FIELDS.includes(editCell.field)

    if (isCritical) {
      // Abrir modal de confirmación
      setPendingCritical({
        tier: editCell.tier,
        field: editCell.field,
        oldValue,
        newValue,
        updatedAt: tierObj.updated_at,
      })
      setReason('')
      cancelEdit()
    } else {
      // Guardar directamente sin modal
      void saveDirect(editCell.tier, editCell.field, newValue, tierObj.updated_at)
      cancelEdit()
    }
  }

  // ── Guardado directo (campos no críticos) ────────────────────────────────────

  async function saveDirect(tierName: TierName, field: EditableField, newValue: number, updatedAt: string) {
    setSaving(true)
    try {
      const res = await fetch('/api/settings/segmentation', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: tierName,
          changes: { [field]: newValue },
          updated_at: updatedAt,
        }),
      })
      const data = await res.json() as { ok?: boolean; error?: string; tier?: SegmentationTier; affected_contacts?: number }

      if (res.status === 409) {
        toast.error(data.error ?? 'Conflicto de concurrencia. Recargando datos...')
        await fetchTiers()
        return
      }
      if (!res.ok) {
        toast.error(data.error ?? `Error ${res.status}`)
        return
      }
      if (data.tier) {
        setTiers(prev => prev.map(t => t.tier === tierName ? { ...t, ...(data.tier as SegmentationTier) } : t))
      }
      toast.success('Cambio guardado correctamente')
    } catch {
      toast.error('Error de red al guardar')
    } finally {
      setSaving(false)
    }
  }

  // ── Guardado desde modal (campos críticos) ────────────────────────────────────

  async function saveCritical() {
    if (!pendingCritical) return
    setSaving(true)
    try {
      const res = await fetch('/api/settings/segmentation', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: pendingCritical.tier,
          changes: { [pendingCritical.field]: pendingCritical.newValue },
          reason: reason.trim(),
          updated_at: pendingCritical.updatedAt,
        }),
      })
      const data = await res.json() as { ok?: boolean; error?: string; tier?: SegmentationTier; affected_contacts?: number }

      if (res.status === 409) {
        toast.error(data.error ?? 'Conflicto de concurrencia. Recargando datos...')
        await fetchTiers()
        setPendingCritical(null)
        return
      }
      if (!res.ok) {
        toast.error(data.error ?? `Error ${res.status}`)
        return
      }
      if (data.tier) {
        setTiers(prev => prev.map(t => t.tier === pendingCritical.tier ? { ...t, ...(data.tier as SegmentationTier) } : t))
      }
      const affected = data.affected_contacts ?? 0
      if (affected > 0) {
        toast.success(`Cambio guardado. ${affected} contacto${affected !== 1 ? 's' : ''} afectado${affected !== 1 ? 's' : ''} en el próximo ciclo.`)
      } else if (affected === -1) {
        toast.success('Cambio guardado correctamente.')
      } else {
        toast.success('Cambio guardado. Sin impacto en contactos actuales.')
      }
      setPendingCritical(null)
    } catch {
      toast.error('Error de red al guardar')
    } finally {
      setSaving(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const FIELDS: EditableField[] = [
    'min_days_inactive',
    'max_days_inactive',
    'value_score',
    'deposit_threshold_min',
    'recontact_cooldown_days',
  ]

  if (loading) return (
    <div className="flex items-center justify-center h-32">
      <Loader2 size={20} className="animate-spin text-gray-400" />
    </div>
  )

  if (fetchError) return (
    <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
      <AlertCircle size={16} className="shrink-0" /> {fetchError}
    </div>
  )

  return (
    <>
      <ToastStack toasts={toast.toasts} />

      {/* Banner informativo */}
      <div className="flex items-start gap-2 bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-3 text-sm text-yellow-800 mb-4">
        <AlertTriangle size={16} className="shrink-0 mt-0.5" />
        <span>
          Los cambios de umbrales toman efecto en el próximo ciclo nocturno del job de scoring (aprox. medianoche).
          Los cambios de cooldown son inmediatos.
        </span>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Tiers de Segmentación</CardTitle>
          {!isAdmin && (
            <p className="text-xs text-gray-400 mt-1">Solo los administradores pueden modificar estos valores.</p>
          )}
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2 pr-4 font-medium text-gray-500 text-xs uppercase tracking-wide">Tier</th>
                  {FIELDS.map(f => (
                    <th key={f} className="text-right py-2 px-3 font-medium text-gray-500 text-xs uppercase tracking-wide whitespace-nowrap">
                      {FIELD_LABELS[f]}
                      {CRITICAL_FIELDS.includes(f) && (
                        <span className="ml-1 text-orange-400" title="Campo crítico — requiere motivo">*</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(tiers.length > 0
                  ? tiers
                  : (['vip', 'alto', 'medio', 'bajo'] as TierName[]).map(t => ({
                      tier: t, min_days_inactive: 0, max_days_inactive: 0, value_score: 0,
                      deposit_threshold_min: 0, recontact_cooldown_days: 0, is_active: true,
                      workspace_id: 'default', updated_at: '',
                    }))
                ).map(tierRow => (
                  <tr key={tierRow.tier} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50">
                    <td className="py-2.5 pr-4">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs ${TIER_COLORS[tierRow.tier]}`}>
                        {TIER_LABELS[tierRow.tier]}
                      </span>
                    </td>

                    {FIELDS.map(field => {
                      const isEditing = editCell?.tier === tierRow.tier && editCell?.field === field
                      const currentValue = tierRow[field] as number

                      return (
                        <td key={field} className="py-2.5 px-3 text-right">
                          {isEditing ? (
                            <div className="flex flex-col items-end gap-1">
                              <Input
                                ref={inputRef}
                                type="number"
                                value={editValue}
                                onChange={e => { setEditValue(e.target.value); setInlineError(null) }}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
                                  if (e.key === 'Escape') cancelEdit()
                                }}
                                className="h-7 text-sm text-right w-24"
                              />
                              {inlineError && (
                                <span className="text-xs text-red-500">{inlineError}</span>
                              )}
                            </div>
                          ) : (
                            <span
                              onClick={() => startEdit(tierRow.tier, field, currentValue)}
                              className={`inline-block min-w-[3rem] px-1 py-0.5 rounded transition-colors ${
                                isAdmin
                                  ? 'cursor-pointer hover:bg-blue-50 hover:text-blue-700'
                                  : 'cursor-default'
                              }`}
                              title={isAdmin ? 'Click para editar' : undefined}
                            >
                              {field === 'deposit_threshold_min'
                                ? `$${currentValue.toLocaleString()}`
                                : currentValue}
                            </span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {isAdmin && (
            <p className="text-xs text-gray-400 mt-3">
              * Campos críticos. Haz click en una celda para editarla. Enter confirma, Escape cancela.
            </p>
          )}
          {saving && !pendingCritical && (
            <div className="flex items-center gap-1 text-xs text-gray-500 mt-2">
              <Loader2 size={12} className="animate-spin" /> Guardando…
            </div>
          )}
        </CardContent>
      </Card>

      {/* Modal de confirmación para campos críticos */}
      <Dialog
        open={!!pendingCritical}
        onOpenChange={open => { if (!open && !saving) setPendingCritical(null) }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Confirmar cambio crítico</DialogTitle>
          </DialogHeader>

          {pendingCritical && (
            <div className="space-y-4">
              <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 text-sm space-y-1">
                <div className="font-medium text-orange-800">
                  {TIER_LABELS[pendingCritical.tier]} — {FIELD_LABELS[pendingCritical.field]}
                </div>
                <div className="text-orange-700">
                  <span className="line-through text-orange-400 mr-2">{pendingCritical.oldValue}</span>
                  <span className="font-semibold">→ {pendingCritical.newValue}</span>
                </div>
                <div className="text-xs text-orange-600 mt-1">
                  Este cambio afecta qué contactos son elegibles para campañas de reactivación.
                  Toma efecto en el próximo ciclo nocturno.
                </div>
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
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { if (!saving) setPendingCritical(null) }}
              disabled={saving}
            >
              Cancelar
            </Button>
            <Button
              onClick={saveCritical}
              disabled={reason.trim().length < 10 || saving}
            >
              {saving
                ? <><Loader2 size={13} className="animate-spin mr-1" />Guardando…</>
                : <>
                    <CheckCircle2 size={13} className="mr-1" />
                    Confirmar cambio
                  </>
              }
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
