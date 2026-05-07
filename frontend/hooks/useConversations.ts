'use client'
import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { fetchJson } from '@/lib/fetchJson'
import {
  applyFilter, priorityScore,
  type Conv, type Message, type Filter,
} from '@/lib/scoring/conversation-scoring'

export function useConversations() {
  const [convs, setConvs]         = useState<Conv[]>([])
  const [selected, setSelected]   = useState<string | null>(null)
  const [messages, setMessages]   = useState<Message[]>([])
  const [reply, setReply]         = useState('')
  const [sending, setSending]     = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [filter, setFilter]       = useState<Filter>('all')
  const [search, setSearch]       = useState('')
  const selectedRef    = useRef<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const loadConvs = useCallback(() => {
    fetchJson<{ conversations: Conv[] }>('/api/conversations')
      .then(d => setConvs(d.conversations || []))
      .catch(() => {})
  }, [])

  const loadMessages = useCallback((phone: string, scroll = false) => {
    fetchJson<{ messages: Message[] }>(`/api/conversations?phone=${phone}`)
      .then(d => {
        setMessages(prev => {
          const next = d.messages || []
          if (scroll || next.length !== prev.length)
            setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
          return next
        })
      })
      .catch(() => {})
  }, [])

  useEffect(() => { loadConvs() }, [loadConvs])

  useEffect(() => {
    const t = setInterval(loadConvs, 5000)
    return () => clearInterval(t)
  }, [loadConvs])

  useEffect(() => {
    const t = setInterval(() => {
      if (selectedRef.current) loadMessages(selectedRef.current)
    }, 3000)
    return () => clearInterval(t)
  }, [loadMessages])

  const openConv = useCallback((phone: string) => {
    setSelected(phone)
    selectedRef.current = phone
    loadMessages(phone, true)
  }, [loadMessages])

  const sendReply = async () => {
    if (!selected || !reply.trim()) return
    setSending(true); setSendError(null)
    let res: Response
    try {
      res = await fetch('/api/send', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ phones: [selected], message: reply }),
      })
    } catch {
      setSending(false); setSendError('Error de red al enviar'); return
    }
    setSending(false)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setSendError(data.error || `Error ${res.status}`); return }
    const result = data.results?.[0]
    if (result?.status === 'error') { setSendError(result.error || 'El envío falló en WhatsApp'); return }
    setReply('')
    openConv(selected)
  }

  const visible = useMemo(() => {
    let list = applyFilter(convs, filter)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(c =>
        c.phone_number.includes(q) ||
        (c.first_name  || '').toLowerCase().includes(q) ||
        (c.last_name   || '').toLowerCase().includes(q) ||
        c.last_message.toLowerCase().includes(q)
      )
    }
    return [...list].sort((a, b) => {
      const delta = priorityScore(b) - priorityScore(a)
      return delta !== 0 ? delta : new Date(b.last_at).getTime() - new Date(a.last_at).getTime()
    })
  }, [convs, filter, search])

  const selectedConv = convs.find(c => c.phone_number === selected)

  return {
    // data
    convs, visible, selected, selectedConv, messages, messagesEndRef,
    // chat input
    reply, setReply, sending, sendError, setSendError,
    // filters
    filter, setFilter, search, setSearch,
    // actions
    openConv, sendReply,
  }
}
