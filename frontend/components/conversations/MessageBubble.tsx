import { fmtTime, type Message } from '@/lib/scoring/conversation-scoring'
import { MsgStatus } from './PriorityBadge'

const IMG_URL_RE = /^https?:\/\/\S+\.(jpg|jpeg|png|gif|webp)(\?[^\s]*)?$/i

export function MessageBubble({ m }: { m: Message }) {
  const out    = m.direction === 'outbound'
  const failed = m.status === 'failed'
  const imgUrl = IMG_URL_RE.test(m.message_body.trim()) ? m.message_body.trim() : null

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
