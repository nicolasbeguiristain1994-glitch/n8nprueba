import { fmtTime, type Message } from '@/lib/scoring/conversation-scoring'
import { MsgStatus } from './PriorityBadge'
import { MessageMedia } from './MessageMedia'

const IMG_URL_RE = /^https?:\/\/\S+\.(jpg|jpeg|png|gif|webp)(\?[^\s]*)?$/i

export function MessageBubble({ m }: { m: Message }) {
  const out    = m.direction === 'outbound'
  const failed = m.status === 'failed'
  const imgUrl = m.media_url || (m.media_type==='sticker' && m.sticker_preview?.startsWith('data:image/webp;base64,') ? m.sticker_preview : IMG_URL_RE.test(m.message_body.trim()) ? m.message_body.trim() : null)

  return (
    <div className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[72%] rounded-2xl text-sm px-3 py-2 ${
        out
          ? failed ? 'bg-destructive/15 text-red-900 border border-red-300 rounded-br-sm'
                   : 'bg-green-500 text-white rounded-br-sm'
          : 'bg-card border border-border text-foreground rounded-bl-sm shadow-sm'
      }`}>
        {imgUrl
          ? <MessageMedia key={imgUrl} src={imgUrl} sticker={m.media_type==='sticker'} />
          : <p className="leading-relaxed whitespace-pre-wrap break-words">{m.message_body}</p>
        }
        {imgUrl && m.media_caption && <p className="leading-relaxed whitespace-pre-wrap break-words mt-2">{m.media_caption}</p>}
        <div className={`flex items-center justify-end gap-1 text-[10px] mt-1 ${
          out ? (failed ? 'text-red-400' : 'text-green-100') : 'text-muted-foreground'
        }`}>
          {fmtTime(m.created_at)}
          {out && <MsgStatus status={m.status} />}
        </div>
      </div>
    </div>
  )
}
