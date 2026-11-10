'use client'
import { useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { Conv } from '@/lib/scoring/conversation-scoring'

export type SavedConversationContact = Pick<Conv, 'contact_id' | 'first_name' | 'last_name' | 'segment'>

export function CreateConversationContact({ phone, agent, onClose, onCreated }: {
  phone: string
  agent: string
  onClose: () => void
  onCreated: (contact: SavedConversationContact) => void
}) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (inFlight.current || !name.trim()) return
    inFlight.current = true
    setSaving(true); setError(null)
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(phone)}/contact?agent=${encodeURIComponent(agent)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'No se pudo guardar el contacto.')
      onCreated(data.contact)
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'No se pudo guardar el contacto. Intentá nuevamente.')
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose() }}>
    <DialogContent showCloseButton={!saving}>
      <DialogHeader>
        <DialogTitle>Crear contacto</DialogTitle>
        <DialogDescription>Guardá a esta persona sin salir de la conversación.</DialogDescription>
      </DialogHeader>
      <form onSubmit={save} className="space-y-4">
        <label className="block space-y-1 text-sm">Teléfono
          <Input value={'+' + phone.replace(/\D/g, '')} readOnly />
        </label>
        <label className="block space-y-1 text-sm">Nombre y apellido
          <Input autoFocus required maxLength={100} value={name} onChange={e => setName(e.target.value)} disabled={saving} autoComplete="name" />
        </label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button type="submit" disabled={saving || !name.trim()}>{saving ? 'Guardando…' : 'Guardar contacto'}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
}
