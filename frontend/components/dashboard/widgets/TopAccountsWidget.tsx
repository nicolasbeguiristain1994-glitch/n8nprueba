'use client'

import { memo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Users } from 'lucide-react'
import type { TopContact } from '@/app/api/dashboard/crm/route'
import { useRouter } from 'next/navigation'

interface Props {
  contacts: TopContact[]
  loading?: boolean
}

function fmt(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`
  return `$${n.toLocaleString('es-AR')}`
}

function initials(name: string) {
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
}

const AVATAR_COLORS = [
  'bg-violet-100 text-violet-700',
  'bg-blue-100 text-blue-700',
  'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-700',
  'bg-rose-100 text-rose-700',
  'bg-teal-100 text-teal-700',
]

export const TopAccountsWidget = memo(function TopAccountsWidget({ contacts, loading }: Props) {
  const router = useRouter()

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="w-4 h-4 text-blue-500" />
          Top contactos
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex gap-3 items-center">
                <div className="w-8 h-8 rounded-full bg-muted animate-pulse shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 bg-muted animate-pulse rounded w-2/3" />
                  <div className="h-2.5 bg-muted animate-pulse rounded w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : contacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-2">
            <Users className="w-8 h-8 opacity-30" />
            <p className="text-sm">Sin contactos con deals</p>
          </div>
        ) : (
          <div className="space-y-1">
            {contacts.map((contact, i) => (
              <button
                key={contact.id}
                onClick={() => router.push(`/contacts`)}
                aria-label={`Ver contacto ${contact.name}`}
                className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${AVATAR_COLORS[i % AVATAR_COLORS.length]}`}>
                  {initials(contact.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{contact.name}</p>
                  <p className="text-xs text-muted-foreground">{contact.deals_count} deal{contact.deals_count !== 1 ? 's' : ''}</p>
                </div>
                <span className="text-sm font-semibold text-muted-foreground shrink-0 tabular-nums">{fmt(contact.total_value)}</span>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
})
