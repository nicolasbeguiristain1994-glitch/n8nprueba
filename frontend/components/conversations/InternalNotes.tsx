'use client'
import { useState, useEffect, useCallback } from 'react'
import { StickyNote, Send, Loader2 } from 'lucide-react'

interface Note {
  id:          string
  content:     string
  author_name: string
  created_at:  string
}

interface Props { phone: string }

function fmtNote(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short' }) +
    ' ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
}

export function InternalNotes({ phone }: Props) {
  const [notes,   setNotes]   = useState<Note[]>([])
  const [text,    setText]    = useState('')
  const [loading, setLoading] = useState(false)
  const [saving,  setSaving]  = useState(false)

  const load = useCallback(() => {
    fetch(`/api/conversations/${encodeURIComponent(phone)}/notes`)
      .then(r => r.ok ? r.json() : { notes: [] })
      .then(d => setNotes(d.notes || []))
      .catch(() => {})
  }, [phone])

  useEffect(() => { setLoading(true); load(); setLoading(false) }, [load])

  const save = async () => {
    const content = text.trim()
    if (!content || saving) return
    setSaving(true)
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(phone)}/notes`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ content }),
      })
      if (res.ok) { setText(''); load() }
    } finally { setSaving(false) }
  }

  return (
    <div className="px-3 py-2.5">
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2 flex items-center gap-1">
        <StickyNote size={10} />
        Notas del equipo
      </p>

      {/* Input */}
      <div className="flex gap-1.5 mb-2.5">
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save() } }}
          placeholder="Agregar nota interna…"
          rows={2}
          className="flex-1 text-xs border border-gray-200 rounded px-2 py-1.5 resize-none focus:outline-none focus:border-indigo-300 placeholder:text-gray-300"
        />
        <button
          onClick={save}
          disabled={!text.trim() || saving}
          className="self-end p-1.5 rounded bg-indigo-600 text-white disabled:opacity-40 hover:bg-indigo-700 transition-colors"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
        </button>
      </div>

      {/* List */}
      {loading
        ? <p className="text-[11px] text-gray-400 text-center py-2">Cargando…</p>
        : notes.length === 0
        ? <p className="text-[11px] text-gray-400 text-center py-2">Sin notas aún</p>
        : (
          <div className="space-y-2 max-h-48 overflow-y-auto pr-0.5">
            {notes.map(n => (
              <div key={n.id} className="bg-amber-50 border border-amber-100 rounded px-2.5 py-2">
                <p className="text-xs text-gray-700 whitespace-pre-wrap">{n.content}</p>
                <p className="text-[10px] text-gray-400 mt-1">
                  {n.author_name} · {fmtNote(n.created_at)}
                </p>
              </div>
            ))}
          </div>
        )
      }
    </div>
  )
}
