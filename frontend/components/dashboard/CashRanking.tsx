'use client'

import { useId, useState } from 'react'
import { ArrowDownUp, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatProviderPesos } from '@/lib/dashboard-format'
import type { CasinoCashRankingRow } from '@/app/api/dashboard/casino/route'

const LABELS: Record<string, string> = { zeus: 'Zeus', bet30: 'Bet30', ganamos: 'Ganamos', argenbet: 'Argenbet' }

export function CashRanking({ rows, loading }: { rows: CasinoCashRankingRow[] | null; loading: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const tableId = useId()
  const visible = expanded ? rows : rows?.slice(0, 5)
  return (
    <section aria-label="Ranking de usuarios con saldo a favor" className="surface mb-6 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight"><ArrowDownUp size={20} className="shrink-0 text-primary" aria-hidden="true" />Top 20 · usuarios con saldo a favor</h2>
          <p className="mt-1 text-sm text-muted-foreground">Mayor diferencia entre retiros y depósitos · Período, plataforma y agente del dashboard · ARS</p>
        </div>
        {!loading && rows && rows.length > 5 && <Button variant="outline" size="sm" aria-expanded={expanded} aria-controls={tableId} onClick={() => setExpanded(value => !value)}>
          {expanded ? 'Mostrar solo 5' : `Ver ranking completo (${rows.length})`}<ChevronDown className={expanded ? 'rotate-180' : ''} aria-hidden="true" />
        </Button>}
      </div>
      {loading ? <p role="status" className="px-5 pb-4 text-sm text-muted-foreground">Consultando ranking…</p>
        : !rows ? <p className="px-5 pb-4 text-sm text-muted-foreground">Ranking no disponible. Reintentá con Refrescar vista.</p>
        : rows.length === 0 ? <p className="px-5 pb-4 text-sm text-muted-foreground">No hay cuentas con retiros mayores a sus depósitos para este período y estos filtros.</p>
        : <div id={tableId} className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Hasta 20 cuentas ordenadas por retiros menos depósitos, de mayor a menor</caption>
            <thead className="border-y bg-muted/40 text-xs text-muted-foreground"><tr>
              {['Puesto', 'Usuario', 'Plataforma', 'Agente', 'Depósitos', 'Retiros', 'A favor del usuario'].map((label, i) => <th key={label} scope="col" className={`whitespace-nowrap px-5 py-3 font-medium ${i >= 4 ? 'text-right' : 'text-left'}`}>{label}</th>)}
            </tr></thead>
            <tbody>{visible?.map((row, i) => <tr key={`${row.platform}:${row.username}`} className="border-b last:border-0 hover:bg-muted/25">
              <td className="px-5 py-3 text-muted-foreground tabular-nums">{i + 1}</td>
              <th scope="row" className="px-5 py-3 text-left font-medium">{row.username}</th>
              <td className="px-5 py-3">{LABELS[row.platform] ?? row.platform}</td>
              <td className="px-5 py-3 capitalize">{row.agentes}</td>
              {[row.depositos, row.retiros, row.diferencia].map((amount, j) => <td key={j} className={`whitespace-nowrap px-5 py-3 text-right tabular-nums ${j === 2 ? 'font-semibold text-rose-600 dark:text-rose-400' : ''}`}>{formatProviderPesos(amount, row.platform)}</td>)}
            </tr>)}</tbody>
          </table>
        </div>}
      <p className="border-t bg-muted/15 px-5 py-3 text-xs leading-relaxed text-muted-foreground">A favor = retiros − depósitos, sin bonos. Refleja movimientos del período, no ganancias de apuestas ni saldo disponible. Cada cuenta se muestra por plataforma; depende del historial cargado.</p>
    </section>
  )
}
