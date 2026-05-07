'use client'
import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ConversationItem } from './ConversationItem'
import type { Conv } from '@/lib/scoring/conversation-scoring'

interface Props {
  items:    Conv[]
  selected: string | null
  onSelect: (phone: string) => void
}

export function VirtualizedConvList({ items, selected, onSelect }: Props) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count:           items.length,
    getScrollElement: () => parentRef.current,
    estimateSize:    () => 74,
    overscan:        6,
  })

  if (items.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-10">Sin conversaciones</p>
  }

  return (
    <div ref={parentRef} className="overflow-y-auto flex-1">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(row => {
          const c = items[row.index]
          return (
            <div
              key={c.phone_number}
              data-index={row.index}
              ref={virtualizer.measureElement}
              style={{
                position:  'absolute',
                top:        0,
                left:       0,
                width:      '100%',
                transform: `translateY(${row.start}px)`,
              }}
            >
              <ConversationItem
                conv={c}
                isSelected={selected === c.phone_number}
                onClick={() => onSelect(c.phone_number)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
