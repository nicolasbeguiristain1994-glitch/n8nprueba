'use client'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Send, Loader2 } from 'lucide-react'
import { useConversations } from '@/hooks/useConversations'
import { ConversationItem }    from '@/components/conversations/ConversationItem'
import { ConversationFilters } from '@/components/conversations/ConversationFilters'
import { ConversationHeader }  from '@/components/conversations/ConversationHeader'
import { MsgStatus }           from '@/components/conversations/PriorityBadge'
import { fmtTime, type Message } from '@/lib/scoring/conversation-scoring'

function MessageBubble({ m }: { m: Message }) {
  const out    = m.direction === 'outbound'
  const failed = m.status === 'failed'
  const imgUrl = /^https?:\/\/\S+\.(jpg|jpeg|png|gif|webp)(\?[^\s]*)?$/i.test(m.message_body.trim())
    ? m.message_body.trim() : null

  return (
    <div className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[72%] rounded-2xl text-sm px-3 py-2 ${
        out
          ? failed ? 'bg-red-100 text-red-900 border border-red-300 rounded-br-sm'
                   : 'bg-green-500 text-white rounded-br-sm'
          : 'bg-white border border-gray-200 text-gray-900 rounded-bl-sm shadow-sm'
      }`}>
        {imgUrl
          ? <img src={imgUrl} alt="media" className="rounded-lg max-w-full max-h-52 object-cover mb-1" />
          : <p className="leading-relaxed whitespace-pre-wrap break-words">{m.message_body}</p>
        }
        <div className={`flex items-center justify-end gap-1 text-[10px] mt-1 ${
          out ? (failed ? 'text-red-400' : 'text-green-100') : 'text-gray-400'
        }`}>
          {fmtTime(m.created_at)}
          {out && <MsgStatus status={m.status} />}
        </div>
      </div>
    </div>
  )
}

export default function Conversations() {
  const {
    convs, visible, selected, selectedConv, messages, messagesEndRef,
    reply, setReply, sending, sendError, setSendError,
    filter, setFilter, search, setSearch,
    openConv, sendReply,
  } = useConversations()

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-xl font-semibold">Conversaciones</h1>
        <p className="text-sm text-gray-500">
          {convs.length} hilos · {convs.filter(c => c.last_direction === 'inbound').length} sin responder
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-[calc(100vh-152px)]">

        {/* Lista */}
        <Card className="overflow-hidden flex flex-col">
          <ConversationFilters
            convs={convs} search={search} filter={filter}
            onSearch={setSearch} onFilter={setFilter}
          />
          <div className="overflow-y-auto flex-1">
            {visible.length === 0
              ? <p className="text-sm text-gray-400 text-center py-10">Sin conversaciones</p>
              : visible.map(c => (
                <ConversationItem
                  key={c.phone_number} conv={c}
                  isSelected={selected === c.phone_number}
                  onClick={() => openConv(c.phone_number)}
                />
              ))
            }
          </div>
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
              </div>
            ) : (
              <>
                <ConversationHeader phone={selected} conv={selectedConv} />

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
                    {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  </Button>
                </div>
              </>
            )
          }
        </Card>
      </div>
    </div>
  )
}
