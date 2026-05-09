'use client'
import { useRef, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Send, Loader2, Smile } from 'lucide-react'
import { useConversations } from '@/hooks/useConversations'
import { useKeyboardShortcuts } from '@/lib/keyboard-shortcuts'
import { VirtualizedConvList }    from '@/components/conversations/VirtualizedConvList'
import { ConversationFilters }    from '@/components/conversations/ConversationFilters'
import { ConversationHeader }     from '@/components/conversations/ConversationHeader'
import { MessageBubble }          from '@/components/conversations/MessageBubble'
import { QuickTemplates }         from '@/components/conversations/QuickTemplates'
import { ConversationSidebar }    from '@/components/conversations/ConversationSidebar'
import { EmojiPicker }            from '@/components/conversations/EmojiPicker'

export default function Conversations() {
  const {
    convs, visible, selected, selectedConv, messages, messagesEndRef,
    reply, setReply, sending, sendError, setSendError,
    filter, setFilter, search, setSearch,
    dateFrom, setDateFrom, dateTo, setDateTo,
    followUpOnly, setFollowUpOnly,
    realtimeStatus,
    notifPermission, requestNotif,
    openConv, sendReply,
  } = useConversations()

  const searchRef    = useRef<HTMLInputElement>(null)
  const textareaRef  = useRef<HTMLTextAreaElement>(null)
  const [showEmoji, setShowEmoji] = useState(false)

  useKeyboardShortcuts([
    { key: 'k', ctrl: true, handler: () => searchRef.current?.focus() },
    { key: 'Escape', handler: () => { setSearch(''); setDateFrom(''); setDateTo(''); setFollowUpOnly(false); setShowEmoji(false) } },
    { key: 'V', ctrl: true, shift: true,
      handler: async () => {
        if (!selectedConv?.contact_id) return
        await fetch(`/api/contacts/${selectedConv.contact_id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ segment: 'vip' }),
        })
        if (selected) openConv(selected)
      },
    },
  ])

  const insertEmoji = (emoji: string) => {
    setReply(prev => prev + emoji)
    setShowEmoji(false)
    textareaRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sin Shift → enviar; Shift+Enter → nueva línea
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendReply()
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-xl font-semibold">Conversaciones</h1>
        <p className="text-sm text-gray-500">
          {convs.length} hilos · {convs.filter(c => c.last_direction === 'inbound').length} sin responder
        </p>
      </div>

      <div className={`grid gap-4 h-[calc(100vh-152px)] ${selected ? 'grid-cols-1 lg:grid-cols-4' : 'grid-cols-1 lg:grid-cols-3'}`}>

        {/* Lista */}
        <Card className="overflow-hidden flex flex-col">
          <ConversationFilters
            convs={convs} search={search} filter={filter}
            dateFrom={dateFrom} dateTo={dateTo} followUpOnly={followUpOnly}
            realtimeStatus={realtimeStatus} notifPermission={notifPermission}
            searchRef={searchRef}
            onSearch={setSearch} onFilter={setFilter}
            onDateFrom={setDateFrom} onDateTo={setDateTo} onFollowUp={setFollowUpOnly}
            onRequestNotif={requestNotif}
          />
          <VirtualizedConvList
            items={visible}
            selected={selected}
            onSelect={openConv}
          />
        </Card>

        {/* Chat */}
        <Card className="lg:col-span-2 flex flex-col overflow-hidden">
          {!selected
            ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 text-gray-400">
                <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center">
                  <Send size={20} className="text-gray-300" />
                </div>
                <p className="text-sm">Seleccioná una conversación</p>
                <p className="text-[11px] text-gray-300">Ctrl+K para buscar</p>
              </div>
            ) : (
              <>
                <ConversationHeader phone={selected} conv={selectedConv} />

                {/* Área de mensajes */}
                <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-gray-50">
                  {messages.length === 0
                    ? <p className="text-center text-gray-400 text-sm pt-10">Sin mensajes aún</p>
                    : messages.map(m => <MessageBubble key={m.id} m={m} />)
                  }
                  <div ref={messagesEndRef} />
                </div>

                {sendError && (
                  <div className="px-3 pt-2 pb-0 shrink-0">
                    <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-1.5 flex items-center justify-between">
                      <span>{sendError}</span>
                      <button onClick={() => setSendError(null)} className="ml-3 text-red-400 hover:text-red-600">✕</button>
                    </p>
                  </div>
                )}

                {/* Input area */}
                <div className="border-t border-gray-100 p-3 bg-white shrink-0">
                  <div className="flex gap-2 items-start">
                    <QuickTemplates
                      contactName={selectedConv?.first_name}
                      onSelect={setReply}
                    />

                    {/* Emoji picker */}
                    <div className="relative">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-gray-400 hover:text-yellow-500 shrink-0"
                        onClick={() => setShowEmoji(v => !v)}
                        type="button"
                      >
                        <Smile size={18} />
                      </Button>
                      {showEmoji && (
                        <div className="absolute bottom-10 left-0 z-50">
                          <EmojiPicker onSelect={insertEmoji} onClose={() => setShowEmoji(false)} />
                        </div>
                      )}
                    </div>

                    <Textarea
                      ref={textareaRef}
                      placeholder="Escribí una respuesta… (Enter para enviar, Shift+Enter para nueva línea)"
                      value={reply}
                      onChange={e => setReply(e.target.value)}
                      onKeyDown={handleKeyDown}
                      rows={1}
                      className="flex-1 resize-none min-h-[36px] max-h-32 overflow-y-auto text-sm leading-relaxed"
                    />

                    <Button
                      onClick={sendReply}
                      disabled={sending || !reply.trim()}
                      size="icon"
                      className="bg-green-600 hover:bg-green-700 shrink-0 h-9 w-9"
                    >
                      {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                    </Button>
                  </div>
                </div>
              </>
            )
          }
        </Card>

        {/* Sidebar */}
        {selected && (
          <Card className="overflow-hidden flex flex-col">
            <ConversationSidebar
              phone={selected}
              conv={selectedConv}
              onRefresh={() => openConv(selected)}
            />
          </Card>
        )}
      </div>
    </div>
  )
}
