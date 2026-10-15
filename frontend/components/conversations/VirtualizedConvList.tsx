'use client'
import { useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ConversationItem } from './ConversationItem'
import type { Conv } from '@/lib/scoring/conversation-scoring'

interface Props {
  items:    Conv[]
  selected: string | null
  onSelect: (phone: string) => void
  selectedCampaign?: string
}

export function VirtualizedConvList({ items, selected, onSelect, selectedCampaign }: Props) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count:           items.length,
    getScrollElement: () => parentRef.current,
    estimateSize:    () => 112,
    getItemKey:      index => items[index].phone_number,
    overscan:        6,
  })

  const first = items[0]
  const firstActivity = first ? `${first.phone_number}:${first.last_at}` : ''
  const previousFirstActivity = useRef(firstActivity)
  useEffect(() => {
    const changed = previousFirstActivity.current !== firstActivity
    previousFirstActivity.current = firstActivity
    if (changed && first?.phone_number === selected && first.last_direction === 'outbound') {
      virtualizer.scrollToOffset(0)
    }
  }, [firstActivity, first?.phone_number, first?.last_direction, selected, virtualizer])

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-10">Sin conversaciones</p>
  }

  return (
    <div ref={parentRef} role="region" aria-label="Lista de conversaciones" className="overflow-y-auto flex-1">
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
                selectedCampaign={selectedCampaign}
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
