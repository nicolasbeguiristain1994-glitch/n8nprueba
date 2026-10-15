import type { Message } from '@/lib/scoring/conversation-scoring'
import { MsgStatus } from './PriorityBadge'
import { MessageMedia } from './MessageMedia'
import { MessageAudio } from './MessageAudio'
import { MessageReactions } from './MessageReactions'

const IMG_URL_RE = /^https?:\/\/\S+\.(jpg|jpeg|png|gif|webp)(\?[^\s]*)?$/i

export function MessageBubble({ m, onReactionChanged }: { m: Message; onReactionChanged?: () => void }) {
  const out    = m.direction === 'outbound'
  const failed = m.status === 'failed'
  const isAudio = m.media_type === 'audio' || m.message_body.trim() === '[audio]'
  const imgUrl = isAudio ? null : m.media_url || (m.media_type==='sticker' && m.sticker_preview?.startsWith('data:image/webp;base64,') ? m.sticker_preview : IMG_URL_RE.test(m.message_body.trim()) ? m.message_body.trim() : null)
  const sentAt = new Date(m.created_at)
  const timeZone = 'America/Argentina/Buenos_Aires'
  const date = sentAt.toLocaleDateString('es-AR', { timeZone, day: '2-digit', month: '2-digit' })
  const time = sentAt.toLocaleTimeString('es-AR', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

  return (
    <div className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
      <div className={isAudio ? 'w-80 max-w-[95%] sm:max-w-[72%]' : 'max-w-[80%] sm:max-w-[72%]'}>
      <div className={`rounded-2xl text-sm px-3 py-2 ${
        out
          ? failed ? 'bg-destructive/15 text-red-900 border border-red-300 rounded-br-sm'
                   : 'bg-green-500 text-white rounded-br-sm'
          : 'bg-card border border-border text-foreground rounded-bl-sm shadow-sm'
      }`}>
        {isAudio
          ? <MessageAudio key={m.media_url || m.id} src={m.media_url} />
          : imgUrl
          ? <MessageMedia key={imgUrl} src={imgUrl} sticker={m.media_type==='sticker'} />
          : <p className="leading-relaxed whitespace-pre-wrap break-words">{m.message_body}</p>
        }
        {imgUrl && m.media_caption && <p className="leading-relaxed whitespace-pre-wrap break-words mt-2">{m.media_caption}</p>}
        <div className={`flex items-center justify-end gap-1 text-[10px] mt-1 ${
          out ? (failed ? 'text-red-400' : 'text-green-100') : 'text-muted-foreground'
        }`}>
          <time
            dateTime={m.created_at}
            title={`${sentAt.toLocaleString('es-AR', { timeZone, hourCycle: 'h23' })} (hora de Argentina)`}
            className="whitespace-nowrap"
          >
            {date} · {time}
          </time>
          {out && <MsgStatus status={m.status} />}
        </div>
      </div>
      <MessageReactions message={m} onChanged={onReactionChanged} />
      </div>
    </div>
  )
}
