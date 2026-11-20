"use client"
import { useEffect, useRef, useState } from 'react'
import { ShieldOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { fmtPhone } from '@/lib/scoring/conversation-scoring'
import { blacklistScopeLabel, type BlacklistEntry } from '@/lib/blacklist-entry'

type Props = { phone: string; agent?: string | null; onRemoved?: () => void; className?: string }

export function RemoveFromBlacklistButton({ phone, agent, onRemoved, className }: Props) {
  const { permissions } = useCurrentUser()
  const [open, setOpen] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [entries, setEntries] = useState<BlacklistEntry[]>([])
  const [entryId, setEntryId] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [retry, setRetry] = useState(0)
  const pending = useRef(false)
  const canManage = permissions.blacklist?.includes('manage') ?? false
  useEffect(() => {
    if (!open || !canManage) return
    const controller = new AbortController()
    setLoading(true); setLoadError(''); setEntries([]); setEntryId('')
    void (async () => {
      try {
        const response = await fetch(`/api/conversations/${encodeURIComponent(phone)}/blacklist`, { signal: controller.signal, cache: 'no-store' })
        const body = await response.json()
        if (!response.ok) throw new Error(body?.error || 'No se pudieron consultar los bloqueos.')
        if (!Array.isArray(body?.entries)) throw new Error('No se pudieron consultar los bloqueos.')
        if (controller.signal.aborted) return
        const active: BlacklistEntry[] = body.entries
        setEntries(active)
        setEntryId(active.find(entry => entry.scope_key === `agent:${agent}`)?.id || (active.length === 1 ? active[0].id : ''))
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : 'No se pudieron consultar los bloqueos.')
      } finally { if (!controller.signal.aborted) setLoading(false) }
    })()
    return () => controller.abort()
  }, [open, phone, agent, canManage, retry])
  if (!canManage) return null
  const selectedEntry = entries.find(entry => entry.id === entryId)
  const changeOpen = (value: boolean) => {
    if (pending.current) return
    setOpen(value); setConfirmed(false); setNote(''); setError('')
  }
  const remove = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!selectedEntry || !confirmed || note.trim().length < 10 || pending.current) return
    pending.current = true; setSaving(true); setError('')
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(phone)}/blacklist`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_id: selectedEntry.id, consent_confirmed: true, consent_note: note.trim() }),
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
          <DialogDescription>Reactivar {fmtPhone(phone)} quitando el bloqueo que elijas. Las demás bajas se conservan.</DialogDescription>
        </DialogHeader>
        {loading ? <p role="status" className="text-sm">Consultando bloqueos…</p> : loadError ? <div className="space-y-3">
          <p role="alert" className="text-sm text-destructive">{loadError}</p>
          <Button type="button" variant="outline" onClick={() => setRetry(value => value + 1)}>Reintentar</Button>
        </div> : entries.length === 0 ? <p role="status" className="text-sm">No quedan bajas activas para este número. Cerrá esta ventana y actualizá la conversación.</p> : <form onSubmit={remove} className="space-y-4">
          <label className="block space-y-2 text-sm">Bloqueo que querés quitar
            <select value={entryId} disabled={saving} required onChange={event => { setEntryId(event.target.value); setConfirmed(false); setNote(''); setError('') }}
              className="w-full rounded-md border border-input bg-background p-2">
              <option value="" disabled>Elegí un bloqueo</option>
              {entries.map(entry => <option key={entry.id} value={entry.id}>{blacklistScopeLabel(entry)}</option>)}
            </select>
          </label>
          {selectedEntry?.reason && <p className="text-sm text-muted-foreground">Motivo de la baja: {selectedEntry.reason}</p>}
          <p className="text-sm text-muted-foreground">No se enviarán mensajes ni se reanudarán campañas al confirmar.</p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={confirmed} disabled={saving || !selectedEntry} onChange={event => setConfirmed(event.target.checked)} className="mt-1" />
            El contacto confirmó que quiere volver a recibir estos mensajes.
          </label>
          <label className="block space-y-2 text-sm">Motivo de reactivación
            <textarea required minLength={10} maxLength={2000} value={note} disabled={saving || !selectedEntry} onChange={event => setNote(event.target.value)}
              placeholder="Indicá cuándo y cómo confirmó que la baja fue un error o que quiere volver a recibir mensajes"
              className="min-h-24 w-full rounded-md border border-input bg-background p-2" />
          </label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => changeOpen(false)}>Cancelar</Button>
            <Button type="submit" disabled={saving || !selectedEntry || !confirmed || note.trim().length < 10}>
              {saving && <Loader2 size={14} className="animate-spin" />}{saving ? 'Quitando…' : 'Confirmar reactivación'}
            </Button>
          </DialogFooter>
        </form>}
      </DialogContent>
    </Dialog>
  </>
}
