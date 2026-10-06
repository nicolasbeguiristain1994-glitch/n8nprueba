'use client'
import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { fetchJson } from '@/lib/fetchJson'
import {
  applyFilter, priorityScore,
  type Conv, type Message, type Filter, type LevelFilter, type CampaignOption,
} from '@/lib/scoring/conversation-scoring'
import { useRealTime, type RealtimeStatus, type SseEvent } from './useRealTime'
import { useDesktopNotifications } from './useDesktopNotifications'

export function useConversations() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messagesError, setMessagesError] = useState<string | null>(null)
  const [convs, setConvs]               = useState<Conv[]>([])
  const [totalConvs, setTotalConvs]     = useState(0)
  const [loadingMore, setLoadingMore]   = useState(false)
  const [selected, setSelected]         = useState<string | null>(null)
  const [messages, setMessages]         = useState<Message[]>([])
  const [reply, setReplyValue]          = useState('')
  const drafts = useRef<Record<string, string>>({})
  const [sending, setSending]           = useState(false)
  const [sendError, setSendError]       = useState<string | null>(null)
  const [filter, setFilter]             = useState<Filter>('all')
  const [campaign, setCampaign]         = useState('all')
  const [agent, setAgent] = useState('all')
  const [agents, setAgents] = useState<{name:string;count:number}[]>([])
  const [level, setLevel]               = useState<LevelFilter>('all')
  const [campaigns, setCampaigns]       = useState<CampaignOption[]>([])
  const [selectedSnapshot, setSelectedSnapshot] = useState<Conv>()
  const [search, setSearch]             = useState('')
  const [dateFrom, setDateFrom]         = useState('')
  const [dateTo, setDateTo]             = useState('')
  const [followUpOnly, setFollowUpOnly] = useState(false)
  const selectedRef    = useRef<string | null>(null)
  const setReply = useCallback((value: React.SetStateAction<string>) => {
    const phone = selectedRef.current
    if (!phone) return
    const next = typeof value === 'function' ? value(drafts.current[phone] ?? '') : value
    drafts.current[phone] = next
    setReplyValue(next)
  }, [])

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const listRequestRef = useRef(0)
  const loadedCountRef = useRef(0)
  const listInFlight = useRef<{ scope: string; controller: AbortController; queued: boolean } | null>(null)
  const messagesInFlight = useRef<{ phone: string; controller: AbortController; queued: boolean; queuedScroll: boolean } | null>(null)
  const scope = new URLSearchParams()
  if (campaign !== 'all') scope.set('campaign', campaign)
  if (agent !== 'all') scope.set('agent', agent)
  if (level !== 'all') scope.set('level', level)
  const scopeKey = scope.toString()
  const scopeRef = useRef(scopeKey)
  scopeRef.current = scopeKey

  const listUrl = useCallback((offset = 0) => {
    const params = new URLSearchParams(scopeKey)
    if (offset) params.set('offset', String(offset))
    return `/api/conversations${params.size ? `?${params}` : ''}`
  }, [scopeKey])

  const loadConvs = useCallback(function refresh(): void {
    // A delayed realtime callback may still belong to the previous filters.
    if (scopeKey !== scopeRef.current) return
    // Polling, visibility and SSE share one active read plus one queued refresh.
    // Keep that final refresh: it may contain an event received during the read.
    if (listInFlight.current?.scope === scopeKey) { listInFlight.current.queued = true; return }
    listInFlight.current?.controller.abort()
    const pending = { scope: scopeKey, controller: new AbortController(), queued: false }
    listInFlight.current = pending
    const timeout = setTimeout(() => pending.controller.abort(), 20_000)
    const request = ++listRequestRef.current
    const isCurrent = () => request === listRequestRef.current && scopeKey === scopeRef.current
    // Poll every loaded page, so refreshing does not discard paginated results.
    const pages = Math.max(1, Math.ceil(loadedCountRef.current / 200))
    void Promise.all(Array.from({ length: pages }, (_, i) =>
      fetchJson<{ conversations: Conv[]; total: number; campaigns?: CampaignOption[]; agents?: {name:string;count:number}[] }>(listUrl(i * 200), { signal: pending.controller.signal })
    ))
      .then(results => {
        if (!isCurrent()) return
        const d = results[0]
        const merged = [...new Map(results.flatMap(page => page.conversations || []).map(c => [c.phone_number, c])).values()]
        setLoadError(null)
        setConvs(merged)
        loadedCountRef.current = merged.length
        setTotalConvs(d.total || 0)
        setCampaigns(d.campaigns || [])
        setAgents(d.agents || [])
      })
      .catch(() => { if (isCurrent()) setLoadError('No se pudieron cargar las conversaciones.') })
      .finally(() => {
        clearTimeout(timeout)
        if (!isCurrent()) return
        listInFlight.current = null
        setLoading(false); setLoadingMore(false)
        if (pending.queued && !document.hidden) refresh()
      })
  }, [listUrl, scopeKey])

  const loadMoreConvs = useCallback(() => {
    if (loadingMore) return
    listInFlight.current?.controller.abort()
    const pending = { scope: scopeKey, controller: new AbortController(), queued: false }
    listInFlight.current = pending
    const timeout = setTimeout(() => pending.controller.abort(), 20_000)
    const request = ++listRequestRef.current
    const isCurrent = () => request === listRequestRef.current && scopeKey === scopeRef.current
    setLoadingMore(true)
    fetchJson<{ conversations: Conv[]; total: number; has_more: boolean }>(
      listUrl(convs.length), { signal: pending.controller.signal }
    )
      .then(d => {
        if (!isCurrent()) return
        const incoming = d.conversations || []
        setConvs(prev => {
          const existing = new Set(prev.map(c => c.phone_number))
          const merged = [...prev, ...incoming.filter(c => !existing.has(c.phone_number))]
          loadedCountRef.current = merged.length
          return merged
        })
        setTotalConvs(d.total || 0)
      })
      .catch(() => { if (isCurrent()) setLoadError('No se pudieron cargar más conversaciones.') })
      .finally(() => {
        clearTimeout(timeout)
        if (!isCurrent()) return
        listInFlight.current = null
        setLoadingMore(false)
        if (pending.queued && !document.hidden) loadConvs()
      })
  }, [convs.length, loadingMore, listUrl, scopeKey, loadConvs])

  const loadMessages = useCallback(function refreshMessages(phone: string, scroll = false): void {
    if (scroll) { setMessagesLoading(true); setMessagesError(null) }
    if (messagesInFlight.current?.phone === phone) {
      messagesInFlight.current.queued = true
      messagesInFlight.current.queuedScroll ||= scroll
      return
    }
    messagesInFlight.current?.controller.abort()
    const pending = { phone, controller: new AbortController(), queued: false, queuedScroll: false }
    messagesInFlight.current = pending
    const isCurrent = () => messagesInFlight.current === pending && selectedRef.current === phone
    const timeout = setTimeout(() => pending.controller.abort(), 20_000)
    fetchJson<{ messages: Message[] }>(`/api/conversations?phone=${phone}`, { signal: pending.controller.signal })
      .then(d => {
        if (!isCurrent()) return
        setMessagesError(null)
        setMessages(prev => {
          const next = d.messages || []
          if (scroll || next.length !== prev.length)
            setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
          return next
        })
      })
      .catch(() => { if (isCurrent()) setMessagesError('No se pudieron cargar los mensajes.') })
      .finally(() => {
        clearTimeout(timeout)
        if (!isCurrent()) return
        messagesInFlight.current = null
        setMessagesLoading(false)
        if (pending.queued && !document.hidden) refreshMessages(phone, pending.queuedScroll)
      })
  }, [])

  // Initial load
  useEffect(() => {
    loadedCountRef.current = 0
    setConvs([]); setTotalConvs(0); setLoading(true); setLoadingMore(false); setLoadError(null)
    loadConvs()
    return () => {
      ++listRequestRef.current
      listInFlight.current?.controller.abort()
      listInFlight.current = null
    }
  }, [loadConvs])

  useEffect(() => () => {
    messagesInFlight.current?.controller.abort()
    messagesInFlight.current = null
  }, [])

  // Fallback polling — SSE handles real-time; polling at 15s catches edge cases
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) loadConvs() }, 15_000)
    return () => clearInterval(t)
  }, [loadConvs])

  // Message polling stays at 3s (SSE triggers conv list only)
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden && selectedRef.current) loadMessages(selectedRef.current) }, 3000)
    return () => clearInterval(t)
  }, [loadMessages])

  const { permission: notifPermission, notify, request: requestNotif } = useDesktopNotifications()

  useEffect(() => {
    const onVisible = () => {
      if (document.hidden) return
      loadConvs()
      if (selectedRef.current) loadMessages(selectedRef.current)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [loadConvs, loadMessages])

  const realtimeRefresh = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (realtimeRefresh.current) clearTimeout(realtimeRefresh.current) }, [])

  // SSE — instant refresh; notify on inbound messages when tab is hidden
  const onRealTimeUpdate = useCallback((event: SseEvent) => {
    if (event.source === 'message' && document.hidden) {
      notify('Nuevo mensaje', 'Hay un nuevo mensaje en una conversación')
    }
    // A burst of delivery events should refresh once, not launch dozens of
    // identical queries. Hidden tabs retain notifications and refresh on return.
    if (document.hidden || realtimeRefresh.current) return
    realtimeRefresh.current = setTimeout(() => {
      realtimeRefresh.current = null
      if (document.hidden) return
      loadConvs()
      if (selectedRef.current) loadMessages(selectedRef.current)
    }, 150)
  }, [loadConvs, loadMessages, notify])

  const realtimeStatus: RealtimeStatus = useRealTime(onRealTimeUpdate)

  const openConv = useCallback((phone: string) => {
    if (selectedRef.current !== phone) { setMessages([]); setSendError(null); setReplyValue(drafts.current[phone] ?? '') }
    setSelected(phone)
    setSelectedSnapshot(previous => convs.find(c => c.phone_number === phone) ??
      (previous?.phone_number === phone ? previous : undefined))
    selectedRef.current = phone
    loadMessages(phone, true)
  }, [loadMessages, convs])

  const sendingRef=useRef(false)
  const sendSticker = async (url:string, token:string):Promise<boolean> => {
    const phone=selectedRef.current
    if(!phone || sendingRef.current)return false
    sendingRef.current=true;setSending(true);setSendError(null)
    try {
      const response=await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phones:[phone],message:'[Sticker]',media_type:'sticker',sticker_data:url,sticker_token:token})})
      const data=await response.json()
      if(!response.ok || data.results?.[0]?.status!=='sent')throw new Error(data.error || data.results?.[0]?.error || 'No se pudo confirmar el envío del sticker.')
      if(selectedRef.current===phone)loadMessages(phone,true)
      loadConvs();return true
    }catch(e){if(selectedRef.current===phone)setSendError(e instanceof Error?e.message:'Error al enviar');return false}
    finally{sendingRef.current=false;setSending(false)}
  }
  const sendReply = async () => {
    if (!selected || !reply.trim() || sendingRef.current) return
    sendingRef.current=true
    setSending(true); setSendError(null)
    const msgText = reply
    let res: Response
    try {
      res = await fetch('/api/send', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ phones: [selected], message: msgText }),
      })
    } catch {
      sendingRef.current=false;setSending(false)
      if (selectedRef.current === selected) setSendError('Error de red al enviar')
      return
    }
    sendingRef.current=false;setSending(false)
    const data = await res.json().catch(() => ({}))
    // A reply may finish after the operator opens another chat. Keep that chat
    // and its draft intact, including when the previous reply fails.
    const result = data.results?.[0]
    const accepted = res.ok && result?.status !== 'error'
    if (accepted && drafts.current[selected] === msgText) delete drafts.current[selected]
    if (selectedRef.current !== selected) { loadConvs(); return }
    if (!res.ok) { setSendError(data.error || `Error ${res.status}`); return }
    if (result?.status === 'error') { setSendError(result.error || 'El envío falló en WhatsApp'); return }
    setReplyValue(drafts.current[selected] ?? '')
    // Actualización optimista: subir la conv al tope inmediatamente sin esperar SSE
    const now = new Date().toISOString()
    setConvs(prev => prev.map(c =>
      c.phone_number === selected
        ? { ...c, last_message: msgText, last_direction: 'outbound', last_at: now }
        : c
    ))
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
    // Ordenar siempre por último mensaje más reciente (comportamiento tipo WhatsApp).
    // priorityScore como desempate secundario para timestamps idénticos.
    return [...list].sort((a, b) => {
      const timeDelta = new Date(b.last_at).getTime() - new Date(a.last_at).getTime()
      return timeDelta !== 0 ? timeDelta : priorityScore(b) - priorityScore(a)
    })
  }, [convs, filter, search, dateFrom, dateTo, followUpOnly])

  const selectedConv = convs.find(c => c.phone_number === selected) ??
    (selectedSnapshot?.phone_number === selected ? selectedSnapshot : undefined)
  const hasMore      = convs.length < totalConvs

  return {
    loading, loadError, messagesLoading, messagesError, refreshConversations: loadConvs,
    convs, visible, selected, selectedConv, messages, messagesEndRef,
    reply, setReply, sending, sendError, setSendError,
    filter, setFilter, search, setSearch,
    campaign, setCampaign, campaigns, level, setLevel, agent, setAgent, agents,
    dateFrom, setDateFrom, dateTo, setDateTo,
    followUpOnly, setFollowUpOnly,
    realtimeStatus,
    notifPermission, requestNotif,
    openConv, sendReply, sendSticker,
    totalConvs, hasMore, loadingMore, loadMoreConvs,
  }
}
