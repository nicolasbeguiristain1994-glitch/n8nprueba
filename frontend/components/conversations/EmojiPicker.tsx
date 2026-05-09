'use client'
import { useEffect, useRef } from 'react'

const EMOJI_GROUPS: { label: string; emojis: string[] }[] = [
  {
    label: 'Frecuentes',
    emojis: ['😊','😂','🙏','👍','❤️','🔥','✅','💪','🎉','😅','🤝','👏','💯','🚀','⭐'],
  },
  {
    label: 'Cara',
    emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😯','😪','😫','🥱','😴','😌','😛','😫','🤢','🤮','🤧','🥵','🥶','😱','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫'],
  },
  {
    label: 'Gestos',
    emojis: ['👍','👎','👌','🤌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👋','🤚','🖐','✋','🖖','👏','🙌','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦿','🦵','🦶','👂','🦻','👃'],
  },
  {
    label: 'Símbolos',
    emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☯️','🕉️','✡️','🛐','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️','🉑','☢️','☣️','📴','📳','🈶','🈚','🈸','🈺','🈷️','✴️','🆚','💮','🉐','㊙️','㊗️','🈴','🈵','🈹','🈲','🅰️','🅱️','🆎','🆑','🅾️','🆘','❌','⭕','🛑','⛔','📛','🚫','💯','💢','♨️','🚷','🚯','🚳','🚱','🔞','📵','🚭','❗','❕','❓','❔','‼️','⁉️','🔅','🔆','〽️','⚠️','🚸','🔱','⚜️','🔰','♻️','✅','🈯','💹','❎','🌐','💠','Ⓜ️','🌀','💤','🏧','🚾','♿','🅿️','🈳','🈹','🛗','🚰','🚹','🚺','🚻','🚼','🚽','🚿','🛁','🛂','🛃','🛄','🛅'],
  },
  {
    label: 'Juegos & Dinero',
    emojis: ['🎰','🃏','🎲','🎮','🕹️','🎯','🏆','🥇','🥈','🥉','🏅','🎖️','💰','💵','💴','💶','💷','💸','💳','💎','💲','🤑','💹','📈','📉','📊'],
  },
]

interface Props {
  onSelect: (emoji: string) => void
  onClose:  () => void
}

export function EmojiPicker({ onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  // Cerrar al clickear fuera
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div
      ref={ref}
      className="bg-white border border-gray-200 rounded-xl shadow-xl w-72 max-h-72 overflow-y-auto p-3 space-y-3"
    >
      {EMOJI_GROUPS.map(group => (
        <div key={group.label}>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1.5">
            {group.label}
          </p>
          <div className="flex flex-wrap gap-0.5">
            {group.emojis.map(emoji => (
              <button
                key={emoji}
                onClick={() => onSelect(emoji)}
                className="text-xl hover:bg-gray-100 rounded p-0.5 transition-colors leading-none"
                type="button"
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
