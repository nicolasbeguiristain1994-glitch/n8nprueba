'use client'
import { Input } from '@/components/ui/input'
import { FILTER_DEFS, applyFilter, type Conv, type Filter } from '@/lib/scoring/conversation-scoring'

interface Props {
  convs:    Conv[]
  search:   string
  filter:   Filter
  onSearch: (value: string) => void
  onFilter: (filter: Filter) => void
}

export function ConversationFilters({ convs, search, filter, onSearch, onFilter }: Props) {
  return (
    <div className="border-b border-gray-100 p-2 space-y-2 shrink-0">
      <Input
        placeholder="Buscar nombre o teléfono…"
        value={search}
        onChange={e => onSearch(e.target.value)}
        className="h-7 text-xs"
      />
      <div className="flex flex-wrap gap-1">
        {FILTER_DEFS.map(({ key, label }) => {
          const count = key === 'all' ? convs.length : applyFilter(convs, key).length
          return (
            <button
              key={key}
              onClick={() => onFilter(key)}
              className={`text-[10px] px-2 py-0.5 rounded-full border font-medium transition-colors ${
                filter === key
                  ? 'bg-green-600 text-white border-green-600'
                  : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
              }`}
            >
              {label}
              {count > 0 && key !== 'all' && <span className="ml-1 opacity-70">{count}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
