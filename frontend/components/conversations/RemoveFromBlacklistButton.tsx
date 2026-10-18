"use client"
import { useRef, useState } from 'react'
import { ShieldOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { fmtPhone } from '@/lib/scoring/conversation-scoring'

type Props = { phone: string; agent?: string | null; onRemoved?: () => void; className?: string }

export function RemoveFromBlacklistButton({ phone, agent, onRemoved, className }: Props) {
  const { permissions } = useCurrentUser()
  const [open, setOpen] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  if (!permissions.blacklist?.includes('manage')) return null
  const changeOpen = (value: boolean) => {
    if (pending.current) return
    setOpen(value); setConfirmed(false); setNote(''); setError('')
  }
  const remove = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!agent || !confirmed || note.trim().length < 10 || pending.current) return
    pending.current = true; setSaving(true); setError('')
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(phone)}/blacklist`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_code: agent, consent_confirmed: true, consent_note: note.trim() }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) throw new Error(body?.error || 'No se pudo quitar de blacklist. Reintentá.')
      setOpen(false); setConfirmed(false); setNote('')
      onRemoved?.()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'No se pudo quitar de blacklist. Reintentá.')
    } finally { pending.current = false; setSaving(false) }
  }
  return <>
    <Button type="button" size="sm" variant="outline" className={className} onClick={() => changeOpen(true)}>
      <ShieldOff size={14} /> Quitar de blacklist
    </Button>
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent showCloseButton={!saving} className="max-w-md">
        <DialogHeader>
          <DialogTitle>Quitar de blacklist</DialogTitle>
          <DialogDescription>{agent ? `Reactivar ${fmtPhone(phone)} para el agente ${agent}. Las bajas de otros agentes se conservan.` : 'Elegí el agente de este contacto en el filtro de Conversaciones para reactivarlo.'}</DialogDescription>
        </DialogHeader>
        {agent ? <form onSubmit={remove} className="space-y-4">
          <p className="text-sm text-muted-foreground">No se enviarán mensajes ni se reanudarán campañas al confirmar.</p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={confirmed} disabled={saving} onChange={event => setConfirmed(event.target.checked)} className="mt-1" />
            El contacto confirmó que quiere volver a recibir mensajes de {agent}.
          </label>
          <label className="block space-y-2 text-sm">Motivo de reactivación
            <textarea required minLength={10} maxLength={2000} value={note} disabled={saving} onChange={event => setNote(event.target.value)}
              placeholder="Indicá cuándo y cómo confirmó que la baja fue un error o que quiere volver a recibir mensajes"
              className="min-h-24 w-full rounded-md border border-input bg-background p-2" />
          </label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => changeOpen(false)}>Cancelar</Button>
            <Button type="submit" disabled={saving || !confirmed || note.trim().length < 10}>
              {saving && <Loader2 size={14} className="animate-spin" />}{saving ? 'Quitando…' : 'Confirmar reactivación'}
            </Button>
          </DialogFooter>
        </form> : <a href="/blacklist" className="text-sm text-primary underline">Revisar en Blacklist</a>}
      </DialogContent>
    </Dialog>
  </>
}
