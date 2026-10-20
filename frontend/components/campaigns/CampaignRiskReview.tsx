'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { CampaignRiskState } from '@/lib/campaign-risk'
import type { CampaignRiskWhatsAppAlertSummary } from '@/lib/campaign-risk-alerts'
import { CampaignRiskWhatsAppStatus } from './CampaignRiskWhatsAppStatus'

type CampaignRiskDetail = CampaignRiskState & { whatsappAlerts?: CampaignRiskWhatsAppAlertSummary[]; whatsappAlertsUnavailable?: boolean }

const SCOPE_LABEL = { campaign: 'Campaña', waba: 'Cuenta de WhatsApp', phone: 'Línea', template: 'Plantilla' }
const METRIC_LABEL: Record<string, string> = {
  delivered: 'Entregados', optOuts: 'Bajas', optouts: 'Bajas', opt_outs: 'Bajas', optOutRate: 'Proporción de bajas',
  attempted: 'Intentos', failed: 'Fallidos', failureRate: 'Proporción de fallos',
  attempts: 'Intentos evaluados', ecosystem: 'Rechazos 131049', ecosystemErrorRate: 'Proporción de rechazos 131049',
  windowHours: 'Ventana máxima (horas)', minimumSample: 'Muestra mínima', threshold: 'Umbral interno',
  sampleSize: 'Tamaño de muestra', quality: 'Calidad', qualityRating: 'Calidad', status: 'Estado',
}

export function CampaignRiskReview({ campaign, canReview, onClose, onRefresh }: {
  campaign: { id: string; name: string }
  canReview: boolean
  onClose: () => void
  onRefresh: () => void
}) {
  const [state, setState] = useState<CampaignRiskDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void fetch(`/api/campaigns/${campaign.id}/risk`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'No se pudo consultar la protección')
        if (!Array.isArray(data.incidents) || typeof data.blocked !== 'boolean') throw new Error('Respuesta de protección inválida')
        if (!controller.signal.aborted) setState(data)
      })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'No se pudo consultar la protección') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [campaign.id, reload])

  const refresh = useCallback(() => { setError(null); setReload(n => n + 1); onRefresh() }, [onRefresh])
  const officialActive = state?.incidents.some(incident => (incident.source === 'meta' || incident.signal === 'meta_check_unavailable') && incident.signalActive) ?? false
  const review = async (event: FormEvent) => {
    event.preventDefault()
    if (!state?.blocked || !canReview || officialActive || loading || saving || note.trim().length < 10) return
    setSaving(true); setError(null); setNotice(null)
    try {
      const response = await fetch(`/api/campaigns/${campaign.id}/risk`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note.trim(), incidentIds: state.incidents.map(incident => incident.id) }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(data.error || 'No se pudo registrar la revisión; la protección se mantiene.')
        if (response.status === 409) setReload(n => n + 1)
        onRefresh()
        return
      }
      setNotice('Revisión registrada. No se inició ningún envío. Cerrá este detalle y reanudá la campaña por separado cuando corresponda.')
      setNote(''); setReload(n => n + 1); onRefresh()
    } catch {
      setError('No se pudo confirmar la revisión. Actualizá el estado antes de volver a intentarlo.')
      setReload(n => n + 1); onRefresh()
    } finally { setSaving(false) }
  }

  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose() }}>
    <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><AlertTriangle size={18} /> Protección de campaña</DialogTitle>
        <DialogDescription className="break-words">{campaign.name}</DialogDescription>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">La protección detiene nuevos envíos ante señales de riesgo. Los mensajes que WhatsApp ya aceptó pueden terminar de entregarse. Ningún control garantiza evitar una suspensión.</p>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold">{state?.blocked ? 'Envíos bloqueados hasta revisar' : state ? 'Sin bloqueo pendiente' : 'Consultando protección'}</p>
        <Button size="sm" variant="outline" onClick={refresh} disabled={loading || saving}><RefreshCw size={13} /> Actualizar estado</Button>
      </div>
      {loading && <p role="status" className="flex gap-2 text-sm"><Loader2 size={16} className="animate-spin" /> Consultando alertas…</p>}
      {state?.incidents.map(incident => <article key={incident.id} className="space-y-2 rounded-lg border border-destructive/25 bg-destructive/5 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-sm">{incident.title}</h3>
          <span className="text-xs text-muted-foreground">{incident.source === 'meta' ? 'Señal de Meta' : 'Control preventivo del panel'} · {SCOPE_LABEL[incident.scopeType]}</span>
        </div>
        <p className="text-sm break-words whitespace-pre-wrap">{incident.detail}</p>
        <p className="text-xs text-muted-foreground">Detectada: {new Date(incident.detectedAt).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })} (hora Argentina)</p>
        {Object.entries(incident.metrics).filter(([key, value]) => METRIC_LABEL[key] && ['number', 'string'].includes(typeof value)).map(([key, value]) =>
          <p className="text-xs" key={key}>{METRIC_LABEL[key]}: {typeof value === 'number' && (key.endsWith('Rate') || key === 'threshold')
            ? new Intl.NumberFormat('es-AR', { style: 'percent', maximumFractionDigits: 1 }).format(value) : String(value)}</p>)}
        {incident.source === 'meta' && <p className="text-xs font-medium">{incident.signalActive ? 'La señal oficial sigue activa; no se puede levantar este bloqueo.' : 'La señal oficial ya no está activa; falta registrar la revisión.'}</p>}
        {incident.signal === 'meta_check_unavailable' && incident.signalActive && <p className="text-xs font-medium">Falta verificar el estado de Meta. Usá Actualizar estado después de restablecer la conexión; el bloqueo se mantiene hasta completar el control.</p>}
        {incident.source === 'panel' && <p className="text-xs text-muted-foreground">Es un criterio preventivo interno, no un umbral de sanción publicado por Meta.</p>}
      </article>)}
      {state && <CampaignRiskWhatsAppStatus alerts={state.whatsappAlerts ?? []} unavailable={state.whatsappAlertsUnavailable === true} />}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="rounded-lg bg-success/10 p-3 text-sm">{notice}</p>}
      {state?.blocked && canReview && <form onSubmit={review} className="space-y-3">
        <label htmlFor="campaign-risk-note" className="block text-sm font-medium">Qué revisaste y qué corregiste</label>
        <Textarea id="campaign-risk-note" value={note} maxLength={2000} rows={3}
          placeholder="Describí la causa revisada y las medidas que tomaste antes de continuar."
          disabled={saving || loading || officialActive} onChange={event => { setNote(event.target.value); setError(null) }} />
        <p className="text-xs text-muted-foreground">Al menos 10 caracteres. Registrar la revisión no envía mensajes ni inicia automáticamente la campaña.</p>
        <Button type="submit" disabled={saving || loading || !!error || officialActive || note.trim().length < 10}>
          {saving && <Loader2 size={14} className="animate-spin" />} Registrar revisión
        </Button>
      </form>}
      {state?.blocked && !canReview && <p className="text-sm text-muted-foreground">El responsable de la campaña o un administrador con permiso de envío debe revisar la alerta.</p>}
      <div className="flex justify-end"><Button variant="outline" disabled={saving} onClick={onClose}>Cerrar</Button></div>
    </DialogContent>
  </Dialog>
}
