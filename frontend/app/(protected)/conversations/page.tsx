'use client'
import { useEffect, useState, useRef, useCallback, useMemo, memo } from 'react'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Send, AlertCircle, Crown, TrendingUp, Zap,
  AlertTriangle, RefreshCw, UserPlus, Check, CheckCheck, Loader2,
} from 'lucide-react'
import { fetchJson } from '@/lib/fetchJson'

// ── Types ──────────────────────────────────────────────────────────────────────

type Segment = 'bajo' | 'medio' | 'alto' | 'vip' | null
type Intent  = 'urgent' | 'complaint' | 'reactivation' | null
type Filter  = 'all' | 'vip' | 'alto' | 'urgent' | 'complaint' | 'escalated' | 'unread'

interface Conv {
  phone_number:       string
  last_message:       string
  last_direction:     string
  last_status:        string
  last_at:            string
  is_escalated?:      boolean
  escalation_reason?: string
  contact_id?:        string | null
  first_name?:        string | null
  last_name?:         string | null
  segment?:           Segment
  actividad?:         string | null
  valor_riesgo?:      string | null
}

interface Message {
  id: string; phone_number: string; message_body: string
  direction: string; status: string; created_at: string
}

// ── Intent detection ───────────────────────────────────────────────────────────

const URGENT    = ['cargar','deposito','depósito','quiero cargar','quiero jugar','bono','depositar','pasas para cargar','quiero depositar','cargas']
const COMPLAINT = ['queja','problema','retiro','bloqueo','bloquearon','no me pagan','no funciona','reclamo','mal servicio','error','me bloquearon']
const REACTIV   = ['volver','regres','hace tiempo','estoy de vuelta','extrañ','cuándo','cuando vuelv']

function detectIntent(msg: string, dir: string): Intent {
  if (dir !== 'inbound') return null
  const l = msg.toLowerCase()
  if (URGENT.some(k    => l.includes(k))) return 'urgent'
  if (COMPLAINT.some(k => l.includes(k))) return 'complaint'
  if (REACTIV.some(k   => l.includes(k))) return 'reactivation'
  return null
}

// ── Priority score (higher = shown first) ─────────────────────────────────────

function priorityScore(c: Conv): number {
  let s = 0
  if (c.segment === 'vip')  s += 100
  if (c.segment === 'alto') s += 70
  const i = detectIntent(c.last_message, c.last_direction)
  if (i === 'urgent')       s += 60
  if (i === 'complaint')    s += 40
  if (c.is_escalated)       s += 40
  if (i === 'reactivation') s += 20
  return s
}

// ── Filter helpers ─────────────────────────────────────────────────────────────

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all',       label: 'Todos' },
  { key: 'vip',       label: 'VIP' },
  { key: 'alto',      label: 'Alto Valor' },
  { key: 'urgent',    label: 'Urgentes' },
  { key: 'complaint', label: 'Quejas' },
  { key: 'escalated', label: 'Escalados' },
  { key: 'unread',    label: 'Sin responder' },
]

function applyFilter(convs: Conv[], f: Filter): Conv[] {
  switch (f) {
    case 'vip':      return convs.filter(c => c.segment === 'vip')
    case 'alto':     return convs.filter(c => c.segment === 'alto')
    case 'urgent':   return convs.filter(c => detectIntent(c.last_message, c.last_direction) === 'urgent')
    case 'complaint':return convs.filter(c => detectIntent(c.last_message, c.last_direction) === 'complaint' || !!c.is_escalated)
    case 'escalated':return convs.filter(c => !!c.is_escalated)
    case 'unread':   return convs.filter(c => c.last_direction === 'inbound')
    default:         return convs
  }
}

// ── Display helpers ────────────────────────────────────────────────────────────

function fmtTime(iso: string) {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })
}

function fmtPhone(p: string) {
  const c = p.replace(/\D/g, '')
  if (c.length === 13 && c.startsWith('549'))
    return `+54 9 ${c.slice(3,5)} ${c.slice(5,9)}-${c.slice(9)}`
  if (c.length === 12 && c.startsWith('54'))
    return `+54 ${c.slice(2,4)} ${c.slice(4,8)}-${c.slice(8)}`
  return `+${c}`
}

function displayName(c: Conv): string {
  if (c.first_name || c.last_name)
    return [c.first_name, c.last_name].filter(Boolean).join(' ')
  return fmtPhone(c.phone_number)
}

function initials(c: Conv): string {
  if (c.first_name) return c.first_name[0].toUpperCase()
  if (c.last_name)  return c.last_name[0].toUpperCase()
  return c.phone_number.slice(-2)
}

function avatarCls(seg: Segment | undefined): string {
  if (seg === 'vip')  return 'bg-yellow-100 text-yellow-700'
  if (seg === 'alto') return 'bg-green-100 text-green-700'
  return 'bg-gray-200 text-gray-600'
}

// ── Sub-components (memoized for perf) ────────────────────────────────────────

function SegBadge({ seg }: { seg: Segment }) {
  if (!seg || seg === 'bajo' || seg === 'medio') return null
  if (seg === 'vip')
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded border bg-yellow-100 text-yellow-800 border-yellow-300">
        <Crown size={9}/> VIP
      </span>
    )
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded border bg-green-100 text-green-800 border-green-300">
      <TrendingUp size={9}/> Alto
    </span>
  )
}

function IntentBadge({ i }: { i: Intent }) {
  if (!i) return null
  const map: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
    urgent:       { label: 'Quiere cargar', cls: 'bg-red-100 text-red-700 border-red-200',         icon: <Zap size={9}/> },
    complaint:    { label: 'Queja/Riesgo',  cls: 'bg-orange-100 text-orange-700 border-orange-200', icon: <AlertTriangle size={9}/> },
    reactivation: { label: 'Reactivación',  cls: 'bg-purple-100 text-purple-700 border-purple-200', icon: <RefreshCw size={9}/> },
  }
  const v = map[i]
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${v.cls}`}>
      {v.icon}{v.label}
    </span>
  )
}

function MsgStatus({ status }: { status: string }) {
  if (status === 'read')      return <CheckCheck size={12} className="text-blue-300 shrink-0"/>
  if (status === 'delivered') return <CheckCheck size={12} className="text-green-100 shrink-0"/>
  if (status === 'sent')      return <Check size={12} className="text-green-100 shrink-0"/>
  if (status === 'failed')    return <span className="text-[11px] text-red-300 shrink-0">✗</span>
  return null
}

const ConversationItem = memo(function ConversationItem({
  c, isSelected, onClick,
}: { c: Conv; isSelected: boolean; onClick: () => void }) {
  const i = detectIntent(c.last_message, c.last_direction)
  const unread = c.last_direction === 'inbound'

  let leftBorder = ''
  if (isSelected)             leftBorder = 'border-l-[3px] border-l-green-500'
  else if (c.segment === 'vip')  leftBorder = 'border-l-[3px] border-l-yellow-400'
  else if (c.segment === 'alto') leftBorder = 'border-l-[3px] border-l-green-500'
  else if (i === 'urgent')       leftBorder = 'border-l-[3px] border-l-red-400'
  else if (i === 'complaint' || c.is_escalated) leftBorder = 'border-l-[3px] border-l-orange-400'
  else if (i === 'reactivation') leftBorder = 'border-l-[3px] border-l-purple-400'
  else                           leftBorder = 'border-l-[3px] border-l-transparent'

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 border-b border-gray-100 hover:bg-gray-50 transition-colors ${leftBorder} ${
        isSelected ? 'bg-green-50' : ''
      }`}
    >
      <div className="flex gap-2.5 items-start">
        {/* Avatar */}
        <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0 mt-0.5 ${avatarCls(c.segment)}`}>
          {initials(c)}
        </div>

        <div className="flex-1 min-w-0">
          {/* Name + time */}
          <div className="flex items-start justify-between gap-1 mb-0.5">
            <span className={`text-sm truncate ${unread ? 'font-semibold text-gray-900' : 'font-medium text-gray-700'}`}>
              {displayName(c)}
            </span>
            <span className="text-[10px] text-gray-400 shrink-0 mt-0.5">{fmtTime(c.last_at)}</span>
          </div>

          {/* Badges */}
          {(c.segment === 'vip' || c.segment === 'alto' || i || c.is_escalated) && (
            <div className="flex flex-wrap gap-1 mb-1">
              <SegBadge seg={c.segment ?? null}/>
              {c.is_escalated
                ? <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-amber-100 text-amber-700 border-amber-200">
                    <AlertCircle size={9}/>Atención
                  </span>
                : <IntentBadge i={i}/>
              }
            </div>
          )}

          {/* Last message */}
          <p className={`text-xs truncate ${unread ? 'text-gray-700' : 'text-gray-400'}`}>
            {c.last_direction === 'outbound' && <span className="text-gray-300 mr-1">↑</span>}
            {c.last_message}
          </p>
        </div>

        {/* Unread dot */}
        {unread && <div className="w-2 h-2 rounded-full bg-green-500 shrink-0 mt-2"/>}
      </div>
    </button>
  )
})

function MessageBubble({ m }: { m: Message }) {
  const out   = m.direction === 'outbound'
  const body  = m.message_body
  const failed = m.status === 'failed'

  // Detect image-only messages
  const imgUrl = /^https?:\/\/\S+\.(jpg|jpeg|png|gif|webp)(\?[^\s]*)?$/i.test(body.trim()) ? body.trim() : null

  return (
    <div className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[72%] rounded-2xl text-sm ${
        out
          ? failed
            ? 'bg-red-100 text-red-900 border border-red-300 rounded-br-sm px-3 py-2'
            : 'bg-green-500 text-white rounded-br-sm px-3 py-2'
          : 'bg-white border border-gray-200 text-gray-900 rounded-bl-sm shadow-sm px-3 py-2'
      }`}>
        {imgUrl
          ? <img src={imgUrl} alt="media" className="rounded-lg max-w-full max-h-52 object-cover mb-1"/>
          : <p className="leading-relaxed whitespace-pre-wrap break-words">{body}</p>
        }
        <div className={`flex items-center justify-end gap-1 text-[10px] mt-1 ${
          out ? (failed ? 'text-red-400' : 'text-green-100') : 'text-gray-400'
        }`}>
          {fmtTime(m.created_at)}
          {out && <MsgStatus status={m.status}/>}
        </div>
      </div>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function Conversations() {
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

  const openConv = (phone: string) => {
    setSelected(phone)
    selectedRef.current = phone
    loadMessages(phone, true)
  }

  const sendReply = async () => {
    if (!selected || !reply.trim()) return
    setSending(true); setSendError(null)
    let res: Response
    try {
      res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phones: [selected], message: reply }),
      })
    } catch {
      setSending(false); setSendError('Error de red al enviar'); return
    }
    setSending(false)
    const d = await res.json().catch(() => ({}))
    if (!res.ok) { setSendError(d.error || `Error ${res.status}`); return }
    const result = d.results?.[0]
    if (result?.status === 'error') { setSendError(result.error || 'El envío falló en WhatsApp'); return }
    setReply('')
    openConv(selected)
  }

  // Filtered + sorted + searched list
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
      const ds = priorityScore(b) - priorityScore(a)
      if (ds !== 0) return ds
      return new Date(b.last_at).getTime() - new Date(a.last_at).getTime()
    })
  }, [convs, filter, search])

  const selectedConv = convs.find(c => c.phone_number === selected)

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-xl font-semibold">Conversaciones</h1>
        <p className="text-sm text-gray-500">{convs.length} hilos · {convs.filter(c => c.last_direction === 'inbound').length} sin responder</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-[calc(100vh-152px)]">

        {/* ── Lista ──────────────────────────────────────────────────────── */}
        <Card className="overflow-hidden flex flex-col">
          {/* Búsqueda + Filtros */}
          <div className="border-b border-gray-100 p-2 space-y-2 shrink-0">
            <Input
              placeholder="Buscar nombre o teléfono…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-7 text-xs"
            />
            <div className="flex flex-wrap gap-1">
              {FILTERS.map(f => {
                const count = f.key === 'all' ? convs.length : applyFilter(convs, f.key).length
                return (
                  <button
                    key={f.key}
                    onClick={() => setFilter(f.key)}
                    className={`text-[10px] px-2 py-0.5 rounded-full border font-medium transition-colors ${
                      filter === f.key
                        ? 'bg-green-600 text-white border-green-600'
                        : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
                    }`}
                  >
                    {f.label}
                    {count > 0 && f.key !== 'all' && (
                      <span className="ml-1 opacity-70">{count}</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="overflow-y-auto flex-1">
            {visible.length === 0
              ? <p className="text-sm text-gray-400 text-center py-10">Sin conversaciones</p>
              : visible.map(c => (
                <ConversationItem
                  key={c.phone_number}
                  c={c}
                  isSelected={selected === c.phone_number}
                  onClick={() => openConv(c.phone_number)}
                />
              ))
            }
          </div>
        </Card>

        {/* ── Chat ───────────────────────────────────────────────────────── */}
        <Card className="lg:col-span-2 flex flex-col overflow-hidden">
          {!selected
            ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 text-gray-400">
                <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center">
                  <Send size={20} className="text-gray-300"/>
                </div>
                <p className="text-sm">Seleccioná una conversación</p>
              </div>
            )
            : <>
                {/* Header */}
                <div className="border-b border-gray-100 px-4 py-3 flex items-center gap-3 shrink-0">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${avatarCls(selectedConv?.segment)}`}>
                    {selectedConv ? initials(selectedConv) : selected.slice(-2)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold">
                        {selectedConv ? displayName(selectedConv) : fmtPhone(selected)}
                      </p>
                      {selectedConv?.segment && <SegBadge seg={selectedConv.segment}/>}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      <p className="text-xs text-gray-400 font-mono">{fmtPhone(selected)}</p>
                      {selectedConv?.actividad && (
                        <span className="text-[10px] text-gray-400 bg-gray-100 rounded px-1.5 py-0.5">
                          {selectedConv.actividad}
                        </span>
                      )}
                      {selectedConv?.valor_riesgo && (
                        <span className="text-[10px] text-gray-400 bg-gray-100 rounded px-1.5 py-0.5">
                          {selectedConv.valor_riesgo}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {!selectedConv?.contact_id && (
                      <a
                        href={`/contacts?phone=${selected}`}
                        className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 bg-indigo-50 border border-indigo-200 rounded-full px-2.5 py-1 whitespace-nowrap"
                      >
                        <UserPlus size={11}/> Crear contacto
                      </a>
                    )}
                    {selectedConv?.is_escalated && (
                      <span className="flex items-center gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                        <AlertCircle size={11}/>Atención requerida
                      </span>
                    )}
                  </div>
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-gray-50">
                  {messages.length === 0
                    ? <p className="text-center text-gray-400 text-sm pt-10">Sin mensajes aún</p>
                    : messages.map(m => <MessageBubble key={m.id} m={m}/>)
                  }
                  <div ref={messagesEndRef}/>
                </div>

                {/* Error banner */}
                {sendError && (
                  <div className="px-3 pt-2 pb-0 shrink-0">
                    <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-1.5 flex items-center justify-between">
                      <span>{sendError}</span>
                      <button onClick={() => setSendError(null)} className="ml-3 text-red-400 hover:text-red-600">✕</button>
                    </p>
                  </div>
                )}

                {/* Reply bar */}
                <div className="border-t border-gray-100 p-3 flex gap-2 bg-white shrink-0">
                  <Input
                    placeholder="Escribí una respuesta…"
                    value={reply}
                    onChange={e => setReply(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendReply()}
                    className="flex-1"
                  />
                  <Button
                    onClick={sendReply}
                    disabled={sending || !reply.trim()}
                    size="icon"
                    className="bg-green-600 hover:bg-green-700 shrink-0"
                  >
                    {sending ? <Loader2 size={16} className="animate-spin"/> : <Send size={16}/>}
                  </Button>
                </div>
              </>
          }
        </Card>
      </div>
    </div>
  )
}
