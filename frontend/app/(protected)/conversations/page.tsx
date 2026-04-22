'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Send } from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'

interface Conv {
  phone_number: string; last_message: string
  last_direction: string; last_status: string; last_at: string
}
interface Message {
  id: string; phone_number: string; message_body: string
  direction: string; status: string; created_at: string
}

export default function Conversations() {
  const [convs, setConvs]         = useState<Conv[]>([])
  const [selected, setSelected]   = useState<string | null>(null)
  const [messages, setMessages]   = useState<Message[]>([])
  const [reply, setReply]         = useState('')
  const [sending, setSending]     = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const selectedRef  = useRef<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const loadConvs = useCallback(() => {
    fetchJson<{ conversations: Conv[] }>('/api/conversations')
      .then(d => setConvs(d.conversations || []))
      .catch(() => setConvs([]))
  }, [])

  const loadMessages = useCallback((phone: string, scroll = false) => {
    fetchJson<{ messages: Message[] }>(`/api/conversations?phone=${phone}`)
      .then(d => {
        setMessages(prev => {
          const next = d.messages || []
          if (scroll || next.length !== prev.length) {
            setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
          }
          return next
        })
      })
      .catch(() => { /* keep existing messages on transient error */ })
  }, [])

  // Carga inicial de conversaciones
  useEffect(() => { loadConvs() }, [loadConvs])

  // Auto-refresh conversaciones cada 5s
  useEffect(() => {
    const t = setInterval(loadConvs, 5000)
    return () => clearInterval(t)
  }, [loadConvs])

  // Auto-refresh mensajes del chat abierto cada 3s
  useEffect(() => {
    const t = setInterval(() => {
      if (selectedRef.current) loadMessages(selectedRef.current)
    }, 3000)
    return () => clearInterval(t)
  }, [loadMessages])

  const openConv = (phone: string) => {
    setSelected(phone)
    selectedRef.current = phone
    loadMessages(phone, true)
  }

  const sendReply = async () => {
    if (!selected || !reply.trim()) return
    setSending(true)
    setSendError(null)
    let res: Response
    try {
      res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phones: [selected], message: reply }),
      })
    } catch {
      setSending(false)
      setSendError('Error de red al enviar')
      return
    }
    setSending(false)
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      setSendError(d.error || `Error ${res.status}`)
      return  // preserve reply text
    }
    setReply('')
    openConv(selected)
  }

  const fmt = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Conversaciones</h1>
        <p className="text-sm text-gray-500">{convs.length} hilos activos</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-[calc(100vh-160px)]">
        {/* Lista */}
        <Card className="overflow-hidden flex flex-col">
          <div className="border-b border-gray-100 p-3">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Recientes</p>
          </div>
          <div className="overflow-y-auto flex-1">
            {convs.length === 0
              ? <p className="text-sm text-gray-400 text-center py-10">Sin conversaciones</p>
              : convs.map(c => (
                <button
                  key={c.phone_number}
                  onClick={() => openConv(c.phone_number)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors ${
                    selected === c.phone_number ? 'bg-green-50 border-l-2 border-l-green-500' : ''
                  }`}
                >
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-sm font-medium font-mono">{c.phone_number}</span>
                    <span className="text-xs text-gray-400">{fmt(c.last_at)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={c.last_direction === 'inbound' ? 'secondary' : 'outline'} className="text-xs py-0">
                      {c.last_direction === 'inbound' ? '↓' : '↑'}
                    </Badge>
                    <p className="text-xs text-gray-500 truncate flex-1">{c.last_message}</p>
                  </div>
                </button>
              ))
            }
          </div>
        </Card>

        {/* Chat */}
        <Card className="lg:col-span-2 flex flex-col overflow-hidden">
          {!selected
            ? <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                Seleccioná una conversación
              </div>
            : <>
                <div className="border-b border-gray-100 px-4 py-3 flex items-center gap-3">
                  <div className="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center text-xs font-medium">
                    {selected.slice(-2)}
                  </div>
                  <div>
                    <p className="text-sm font-medium font-mono">{selected}</p>
                    <p className="text-xs text-gray-400">{messages.length} mensajes</p>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                  {messages.length === 0
                    ? <p className="text-center text-gray-400 text-sm pt-10">Sin mensajes aún</p>
                    : messages.map(m => (
                    <div key={m.id} className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-xs lg:max-w-sm px-3 py-2 rounded-2xl text-sm ${
                        m.direction === 'outbound'
                          ? 'bg-green-500 text-white rounded-br-sm'
                          : 'bg-gray-100 text-gray-900 rounded-bl-sm'
                      }`}>
                        <p>{m.message_body}</p>
                        <p className={`text-xs mt-1 ${m.direction === 'outbound' ? 'text-green-100' : 'text-gray-400'}`}>
                          {fmt(m.created_at)}
                          {m.direction === 'outbound' && ` · ${m.status}`}
                        </p>
                      </div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>

                {sendError && (
                  <div className="px-3 pt-2 pb-0">
                    <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-1.5 flex items-center justify-between">
                      <span>{sendError}</span>
                      <button onClick={() => setSendError(null)} className="ml-3 text-red-400 hover:text-red-600">✕</button>
                    </p>
                  </div>
                )}
                <div className="border-t border-gray-100 p-3 flex gap-2">
                  <Input
                    placeholder="Escribí una respuesta…"
                    value={reply}
                    onChange={e => setReply(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendReply()}
                    className="flex-1"
                  />
                  <Button onClick={sendReply} disabled={sending || !reply.trim()} size="icon"
                          className="bg-green-600 hover:bg-green-700">
                    <Send size={16} />
                  </Button>
                </div>
              </>
          }
        </Card>
      </div>
    </div>
  )
}
