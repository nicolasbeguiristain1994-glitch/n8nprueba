'use client'

import { useRef, useState } from 'react'
import { Loader2, SmilePlus } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from '@/components/ui/dialog'
import { EmojiPicker } from './EmojiPicker'
import { QUICK_REACTIONS, type MessageReaction } from '@/lib/message-reactions'
import type { Message } from '@/lib/scoring/conversation-scoring'

export function MessageReactions({ message, onChanged }: { message: Message; onChanged?: () => void }) {
  const [open, setOpen] = useState(false)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState<string | null>(null)
  // Keep an accepted change visible until the next server snapshot arrives.
  const [override, setOverride] = useState<{ snapshot: Message['reactions']; reactions: MessageReaction[] } | null>(null)
  const reactions = override && override.snapshot === message.reactions ? override.reactions : message.reactions ?? []
  const own = reactions.find(reaction => reaction.actor === 'self')?.emoji

  async function react(emoji: string) {
    if (pending.current || !message.can_react) return
    pending.current = true
    setBusy(true); setError(null); setOpen(false); setMore(false)
    const nextEmoji = emoji === own ? '' : emoji
    try {
      const response = await fetch('/api/conversations/reactions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: message.id, requestId: crypto.randomUUID(), emoji: nextEmoji }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || 'No se pudo enviar la reacción.')
      setOverride({ snapshot: message.reactions, reactions: [
        ...reactions.filter(reaction => reaction.actor !== 'self'),
        ...(nextEmoji ? [{ emoji: nextEmoji, actor: 'self' as const }] : []),
      ] })
      onChanged?.()
    } catch (error) {
      setError(error instanceof Error && !(error instanceof TypeError) ? error.message : 'No se pudo confirmar la reacción. Revisá WhatsApp antes de volver a intentarlo.')
    } finally { pending.current = false; setBusy(false) }
  }

  return <div className="mt-1 text-foreground">
    <div className="flex items-center gap-1 flex-wrap">
      {reactions.map(reaction => reaction.actor === 'self'
        ? <button key={reaction.actor} type="button" disabled={busy || !message.can_react}
            onClick={() => void react('')} aria-label={`Quitar nuestra reacción ${reaction.emoji}`}
            title="Nuestra reacción · tocar para quitar"
            className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-base disabled:opacity-60">{reaction.emoji}</button>
        : <span key={reaction.actor} title="Reacción del contacto" aria-label={`Reacción del contacto ${reaction.emoji}`}
            className="rounded-full border border-border bg-card px-2 py-0.5 text-base">{reaction.emoji}</span>)}
      {message.can_react && <Dialog open={open} onOpenChange={value => { setOpen(value); if (!value) setMore(false) }}>
        <DialogTrigger disabled={busy} aria-label="Reaccionar al mensaje" title="Reaccionar al mensaje"
          className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <SmilePlus className="size-4" />}
        </DialogTrigger>
        <DialogContent className="sm:max-w-sm gap-3">
          <DialogTitle>Reaccionar al mensaje</DialogTitle>
          <DialogDescription className="line-clamp-2 break-words pr-4">{message.message_body || 'Mensaje de WhatsApp'}</DialogDescription>
          <div className="flex flex-wrap gap-1" aria-label="Reacciones frecuentes">
            {QUICK_REACTIONS.map(emoji => <button key={emoji} type="button" aria-label={`Reaccionar con ${emoji}`}
              aria-pressed={own === emoji} onClick={() => void react(emoji)}
              className={`rounded-lg p-2 text-2xl hover:bg-muted ${own === emoji ? 'bg-primary/10 ring-1 ring-primary' : ''}`}>{emoji}</button>)}
          </div>
          {more ? <EmojiPicker onSelect={emoji => void react(emoji)} onClose={() => setMore(false)} />
            : <button type="button" className="text-sm text-primary text-left hover:underline" onClick={() => setMore(true)}>Más emojis</button>}
          {own && <button type="button" className="text-sm text-muted-foreground text-left hover:underline" onClick={() => void react('')}>Quitar reacción {own}</button>}
        </DialogContent>
      </Dialog>}
    </div>
    {(error || message.reaction_error) && <p role="alert" className="mt-1 max-w-xs text-xs text-destructive">{error || message.reaction_error}</p>}
  </div>
}
