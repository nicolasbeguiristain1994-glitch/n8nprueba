'use client'
import { useEffect, useRef, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/layout/PageHeader'
import { cn } from '@/lib/utils'
import { Send, Loader2, Smile, ArrowLeft, PanelRight } from 'lucide-react'
import { useConversations } from '@/hooks/useConversations'
import { useKeyboardShortcuts } from '@/lib/keyboard-shortcuts'
import { VirtualizedConvList }    from '@/components/conversations/VirtualizedConvList'
import { ConversationFilters }    from '@/components/conversations/ConversationFilters'
import { ConversationHeader }     from '@/components/conversations/ConversationHeader'
import { MessageBubble }          from '@/components/conversations/MessageBubble'
import { QuickTemplates }         from '@/components/conversations/QuickTemplates'
import { ConversationSidebar }    from '@/components/conversations/ConversationSidebar'
import { CloudWindowIndicator } from '@/components/conversations/CloudWindowIndicator'
import { StickerPicker } from '@/components/conversations/StickerPicker'
import { EmojiPicker }            from '@/components/conversations/EmojiPicker'

export default function Conversations() {
  const {
    loading, loadError, messagesLoading, messagesError, refreshConversations,
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
  } = useConversations()

  const searchRef    = useRef<HTMLInputElement>(null)
  const textareaRef  = useRef<HTMLTextAreaElement>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const openedFromLink = useRef(false)
  const [showEmoji, setShowEmoji] = useState(false)
  const [mobilePanel, setMobilePanel] = useState<'list' | 'chat' | 'details'>('list')

  useEffect(() => {
    if (loading || openedFromLink.current) return
    openedFromLink.current = true
    const phone = new URLSearchParams(window.location.search).get('phone')
    if (phone) { openConv(phone); setMobilePanel('chat') }
  }, [loading, openConv])

  useKeyboardShortcuts([
    { key: 'F', ctrl: true, shift: true, handler: () => searchRef.current?.focus() },
    { key: 'Escape', handler: () => { setSearch(''); setFilter('all'); setCampaign('all'); setLevel('all'); setAgent('all'); setDateFrom(''); setDateTo(''); setFollowUpOnly(false); setShowEmoji(false) } },
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
      <PageHeader title="Conversaciones" description={`${convs.length}${totalConvs > convs.length ? ` de ${totalConvs}` : ''} hilos · ${convs.filter(c => c.last_direction === 'inbound').length} sin responder`} />

      <div className={cn('grid min-h-[420px] h-[calc(100dvh-16rem)] gap-3 md:h-[calc(100dvh-13rem)] lg:grid-cols-[300px_minmax(0,1fr)]', selected && detailsOpen && 'xl:grid-cols-[300px_minmax(0,1fr)_280px]')}>

        {/* Lista */}
        <Card className={cn("min-h-0 overflow-hidden flex-col gap-0 py-0", mobilePanel === 'list' ? 'flex' : 'hidden lg:flex')}>
          <ConversationFilters
            convs={convs} search={search} filter={filter}
            campaign={campaign} campaigns={campaigns} onCampaign={setCampaign}
            level={level} onLevel={setLevel} agent={agent} agents={agents} onAgent={setAgent}
            dateFrom={dateFrom} dateTo={dateTo} followUpOnly={followUpOnly}
            realtimeStatus={realtimeStatus} notifPermission={notifPermission}
            searchRef={searchRef}
            onSearch={setSearch} onFilter={setFilter}
            onDateFrom={setDateFrom} onDateTo={setDateTo} onFollowUp={setFollowUpOnly}
            onRequestNotif={requestNotif}
          />
          {loadError && <div role="alert" className="border-b border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">{loadError}<button onClick={refreshConversations} className="ml-2 underline">Reintentar</button></div>}
          {loading ? <div role="status" className="space-y-3 p-3"><span className="sr-only">Cargando conversaciones…</span>{[0, 1, 2, 3].map(i => <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />)}</div> : (!loadError || visible.length > 0) && <VirtualizedConvList
            items={visible}
            selectedCampaign={campaign}
            selected={selected}
            onSelect={phone => { openConv(phone); setMobilePanel('chat'); setDetailsOpen(false) }}
          />}
          {hasMore && (
            <div className="border-t px-3 py-2 shrink-0">
              <Button
                variant="ghost" size="sm"
                className="w-full text-xs text-muted-foreground hover:text-foreground"
                onClick={loadMoreConvs}
                disabled={loadingMore}
              >
                {loadingMore
                  ? <><Loader2 size={11} className="animate-spin mr-1.5"/> Cargando…</>
                  : `Cargar más · ${totalConvs - convs.length} restantes`
                }
              </Button>
            </div>
          )}
        </Card>

        {/* Chat */}
        <Card className={cn("min-h-0 flex-col gap-0 overflow-hidden py-0", mobilePanel === 'chat' ? 'flex' : mobilePanel === 'details' ? 'hidden xl:flex' : 'hidden lg:flex')}>
          {selected && <div className="flex items-center justify-between border-b px-3 py-2">
            <Button size="sm" variant="ghost" onClick={() => setMobilePanel('list')} className="lg:hidden"><ArrowLeft size={14} /> Conversaciones</Button>
            <Button size="sm" variant="ghost" onClick={() => { setDetailsOpen(v=>!v); setMobilePanel(detailsOpen?'chat':'details') }} aria-expanded={detailsOpen} className="ml-auto"><PanelRight size={14} /> Detalles</Button>
          </div>}
          {!selected
            ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                  <Send size={20} className="text-muted-foreground/60" />
                </div>
                <p className="text-sm">Seleccioná una conversación</p>
                <p className="text-[11px] text-muted-foreground/60">Ctrl/⌘ + Shift + F para buscar</p>
              </div>
            ) : (
              <>
                <ConversationHeader phone={selected} conv={selectedConv} selectedCampaign={campaign} />
                <CloudWindowIndicator key={selected} phone={selected} />

                {/* Área de mensajes */}
                <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-background">
                  {messagesError && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{messagesError}<button className="ml-2 underline" onClick={() => openConv(selected)}>Reintentar</button></p>}
                  {messagesLoading ? <p role="status" className="pt-10 text-center text-sm text-muted-foreground">Cargando mensajes…</p> : messagesError && messages.length === 0 ? null : messages.length === 0
                    ? <p className="text-center text-muted-foreground text-sm pt-10">Sin mensajes aún</p>
                    : messages.map(m => <MessageBubble key={m.id} m={m} />)
                  }
                  <div ref={messagesEndRef} />
                </div>

                {sendError && (
                  <div className="px-3 pt-2 pb-0 shrink-0">
                    <p className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded px-3 py-1.5 flex items-center justify-between">
                      <span>{sendError}</span>
                      <button onClick={() => setSendError(null)} className="ml-3 text-red-400 hover:text-destructive">✕</button>
                    </p>
                  </div>
                )}

                {/* Input area */}
                <div className="border-t border-border p-3 bg-card shrink-0">
                  {reply.trim() && <p className="mb-2 text-xs text-muted-foreground" role="status">Borrador de este contacto · se conserva al cambiar de chat durante esta sesión</p>}
                  <div className="flex gap-2 items-start">
                    <StickerPicker key={selected} disabled={sending} onSend={sendSticker} />
                    <QuickTemplates
                      contactName={selectedConv?.first_name}
                      onSelect={setReply}
                    />

                    {/* Emoji picker */}
                    <div className="relative">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-muted-foreground hover:text-yellow-500 shrink-0"
                        onClick={() => setShowEmoji(v => !v)}
                        type="button"
                        aria-label="Insertar emoji" aria-expanded={showEmoji}
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
                      aria-label="Respuesta al contacto"
                      placeholder="Escribí una respuesta… (Enter para enviar, Shift+Enter para nueva línea)"
                      value={reply}
                      onChange={e => setReply(e.target.value)}
                      onKeyDown={handleKeyDown}
                      rows={1}
                      className="min-w-0 flex-1 resize-none min-h-[36px] max-h-32 overflow-y-auto text-sm leading-relaxed"
                    />

                    <Button
                      onClick={sendReply}
                      aria-label="Enviar respuesta"
                      disabled={sending || !reply.trim()}
                      size="icon"
                      className="bg-primary hover:bg-primary/90 shrink-0 h-9 w-9"
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
        {selected && (detailsOpen || mobilePanel === 'details') && (
          <Card className={cn("min-h-0 overflow-y-auto flex-col gap-0 py-0", mobilePanel === 'details' ? 'flex' : 'hidden xl:flex')}>
            <div className="border-b p-2"><Button size="sm" variant="ghost" onClick={() => { setMobilePanel('chat'); setDetailsOpen(false) }}><ArrowLeft size={14} /> Volver al chat</Button></div>
            <ConversationSidebar
              phone={selected}
              conv={selectedConv}
              onRefresh={() => { refreshConversations(); openConv(selected) }}
            />
          </Card>
        )}
      </div>
    </div>
  )
}
