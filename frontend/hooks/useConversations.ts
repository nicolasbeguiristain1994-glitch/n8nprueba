'use client'
import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { fetchJson } from '@/lib/fetchJson'
import {
  applyFilter, priorityScore,
  type Conv, type Message, type Filter,
} from '@/lib/scoring/conversation-scoring'
import { useRealTime, type RealtimeStatus } from './useRealTime'

export function useConversations() {
  const [convs, setConvs]               = useState<Conv[]>([])
  const [selected, setSelected]         = useState<string | null>(null)
  const [messages, setMessages]         = useState<Message[]>([])
  const [reply, setReply]               = useState('')
  const [sending, setSending]           = useState(false)
  const [sendError, setSendError]       = useState<string | null>(null)
  const [filter, setFilter]             = useState<Filter>('all')
  const [search, setSearch]             = useState('')
  const [dateFrom, setDateFrom]         = useState('')
  const [dateTo, setDateTo]             = useState('')
  const [followUpOnly, setFollowUpOnly] = useState(false)
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

  // Initial load
  useEffect(() => { loadConvs() }, [loadConvs])

  // Fallback polling — SSE handles real-time; polling at 15s catches edge cases
  useEffect(() => {
    const t = setInterval(loadConvs, 15_000)
    return () => clearInterval(t)
  }, [loadConvs])

  // Message polling stays at 3s (SSE triggers conv list only)
  useEffect(() => {
    const t = setInterval(() => { if (selectedRef.current) loadMessages(selectedRef.current) }, 3000)
    return () => clearInterval(t)
  }, [loadMessages])

  // SSE — instant refresh on any server-side event
  const onRealTimeUpdate = useCallback(() => {
    loadConvs()
    if (selectedRef.current) loadMessages(selectedRef.current)
  }, [loadConvs, loadMessages])

  const realtimeStatus: RealtimeStatus = useRealTime(onRealTimeUpdate)

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
    if (dateFrom)    list = list.filter(c => c.last_at >= dateFrom)
    if (dateTo)      list = list.filter(c => c.last_at <= dateTo + 'T23:59:59.999Z')
    if (followUpOnly) list = list.filter(c => !!c.has_follow_up)
    return [...list].sort((a, b) => {
      const delta = priorityScore(b) - priorityScore(a)
      return delta !== 0 ? delta : new Date(b.last_at).getTime() - new Date(a.last_at).getTime()
    })
  }, [convs, filter, search, dateFrom, dateTo, followUpOnly])

  const selectedConv = convs.find(c => c.phone_number === selected)

  return {
    convs, visible, selected, selectedConv, messages, messagesEndRef,
    reply, setReply, sending, sendError, setSendError,
    filter, setFilter, search, setSearch,
    dateFrom, setDateFrom, dateTo, setDateTo,
    followUpOnly, setFollowUpOnly,
    realtimeStatus,
    openConv, sendReply,
  }
}
