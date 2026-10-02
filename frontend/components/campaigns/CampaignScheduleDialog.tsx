'use client'

import { useState, type FormEvent } from 'react'
import { Clock, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const AR_TZ = 'America/Argentina/Buenos_Aires'
function argentinaFields(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return { date: '', time: '' }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: AR_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? ''
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` }
}

export function CampaignScheduleDialog({ campaign, onClose, onSaved, onRefresh }: {
  campaign: { id: string; name: string; scheduled_at: string }
  onClose: () => void
  onSaved: (scheduledAt: string) => void
  onRefresh: () => void
}) {
  const [fields, setFields] = useState(() => argentinaFields(campaign.scheduled_at))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scheduledAt = `${fields.date}T${fields.time}:00-03:00`
  const valid = !!fields.date && !!fields.time && Number.isFinite(Date.parse(scheduledAt))
  const preview = valid ? new Date(scheduledAt).toLocaleString('es-AR', {
    timeZone: AR_TZ, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }) : null

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    if (!valid || Date.parse(scheduledAt) <= Date.now()) {
      setError('Elegí una fecha y hora futuras, en hora de Argentina.')
      return
    }
    setSaving(true); setError(null)
    try {
      const response = await fetch(`/api/campaigns/${campaign.id}/schedule`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_at: scheduledAt, expected_scheduled_at: campaign.scheduled_at }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(data.error || 'No se pudo actualizar el horario')
        if (response.status === 409) onRefresh()
        return
      }
      onSaved(data.scheduled_at)
    } catch {
      setError('No se pudo confirmar el cambio. Actualizá las campañas para comprobar el horario antes de reintentar.')
      onRefresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !saving) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Editar horario</DialogTitle>
          <DialogDescription className="break-words">{campaign.name}</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <p className="text-sm text-muted-foreground">Elegí cuándo querés iniciar el envío. Fecha y hora de Argentina (UTC−03:00).</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="min-w-0">
              <label htmlFor="edit-campaign-date" className="mb-1 block text-sm font-medium">Fecha de envío</label>
              <Input id="edit-campaign-date" type="date" required value={fields.date}
                min={argentinaFields(new Date().toISOString()).date} disabled={saving}
                onChange={event => { setFields(prev => ({ ...prev, date: event.target.value })); setError(null) }} />
            </div>
            <div className="min-w-0">
              <label htmlFor="edit-campaign-time" className="mb-1 block text-sm font-medium">Hora de envío</label>
              <Input id="edit-campaign-time" type="time" required step={60} value={fields.time} disabled={saving}
                onChange={event => { setFields(prev => ({ ...prev, time: event.target.value })); setError(null) }} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Formato de 24 horas: 17:30 equivale a las 5:30 de la tarde.</p>
          {preview && <p role="status" className="rounded-lg bg-accent p-3 text-sm text-accent-foreground">
            Nuevo horario: <strong>{preview}</strong> (hora Argentina)
          </p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={saving || !valid}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Clock size={14} />}
              {saving ? 'Guardando…' : 'Guardar horario'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
