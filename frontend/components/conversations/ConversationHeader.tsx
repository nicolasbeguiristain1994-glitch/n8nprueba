import { AlertCircle, UserPlus } from 'lucide-react'
import { displayName, fmtPhone, avatarCls, initials, type Conv } from '@/lib/scoring/conversation-scoring'
import { SegmentBadge } from './PriorityBadge'

interface Props {
  phone: string
  conv:  Conv | undefined
}

export function ConversationHeader({ phone, conv }: Props) {
  return (
    <div className="border-b border-gray-100 px-4 py-3 flex items-center gap-3 shrink-0">
      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${avatarCls(conv?.segment)}`}>
        {conv ? initials(conv) : phone.slice(-2)}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold">{conv ? displayName(conv) : fmtPhone(phone)}</p>
          {conv?.segment && <SegmentBadge segment={conv.segment} />}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <p className="text-xs text-gray-400 font-mono">{fmtPhone(phone)}</p>
          {conv?.actividad && (
            <span className="text-[10px] text-gray-400 bg-gray-100 rounded px-1.5 py-0.5">
              {conv.actividad}
            </span>
          )}
          {conv?.valor_riesgo && (
            <span className="text-[10px] text-gray-400 bg-gray-100 rounded px-1.5 py-0.5">
              {conv.valor_riesgo}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {!conv?.contact_id && (
          <a
            href={`/contacts?phone=${phone}`}
            className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 bg-indigo-50 border border-indigo-200 rounded-full px-2.5 py-1 whitespace-nowrap"
          >
            <UserPlus size={11} /> Crear contacto
          </a>
        )}
        {conv?.is_escalated && (
          <span className="flex items-center gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
            <AlertCircle size={11} /> Atención
          </span>
        )}
      </div>
    </div>
  )
}
