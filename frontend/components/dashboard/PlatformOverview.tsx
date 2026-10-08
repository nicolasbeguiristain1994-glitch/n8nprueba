'use client'

import { SYNC_PLATFORMS, type Platform, type SyncPlatform } from '@/lib/casino-agents'
import { configuredAgentAccounts } from '@/lib/dashboard-scope'
import { formatProviderPesos, sumProviderPesos } from '@/lib/dashboard-format'
import type { PlatformActivity } from '@/lib/dashboard-overview'
import { ArrowUpFromLine, Coins, Gift, Info, Wallet } from 'lucide-react'
import { cn } from '@/lib/utils'

const LABELS: Record<SyncPlatform, string> = { zeus: 'Zeus', bet30: 'Bet30', ganamos: 'Ganamos', argenbet: 'Argenbet' }
const PLATFORM_STYLES: Record<SyncPlatform, string> = {
  zeus: 'bg-primary/10 text-primary',
  bet30: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  ganamos: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  argenbet: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
}
const METRICS = [
  { field: 'depositos', label: 'Depósitos sin bonos', icon: Coins, style: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  { field: 'retiros', label: 'Retiros registrados', icon: ArrowUpFromLine, style: 'bg-rose-500/10 text-rose-600 dark:text-rose-400' },
  { field: 'bonos', label: 'Bonos registrados', icon: Gift, style: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  { field: 'saldo_con_bonos', label: 'Saldo con bonos registrados', icon: Wallet, style: 'bg-primary/10 text-primary' },
] as const
const dateLabel = (date: string | null) => date ? date.split('-').reverse().join('/') : 'Sin movimientos registrados'
const accountKey = (name: string) => name.trim().toLowerCase()
export const UNCONFIGURED_ACCOUNT = 'Sin cuenta de este agente configurada en esta plataforma'

export function PlatformOverview({ activity, platform, agent, from, to, loading }: {
  activity: PlatformActivity[] | null
  platform: Platform
  agent: string
  from: string
  to: string
  loading: boolean
}) {
  const platforms = platform === 'consolidado' ? SYNC_PLATFORMS : [platform]
  if (loading) return <div role="status" className="mb-5 rounded-xl border p-6 text-sm text-muted-foreground">Consultando movimientos de las plataformas…</div>
  if (!activity) return <p className="mb-5 rounded-xl border p-4 text-sm text-muted-foreground">Resumen de plataformas no disponible. Reintentá la consulta.</p>
  // Configured and observed accounts match case/space-insensitively, like the SQL agent filter;
  // every observed account keeps its own row and is never hidden.
  const scopes = platforms.map(p => {
    const expected = configuredAgentAccounts(platform, p, agent)
    const observed = activity.filter(row => row.platform === p && row.agente !== null)
    const rows: { name: string; row?: PlatformActivity }[] = [
      ...expected.flatMap(name => {
        const matches = observed.filter(row => accountKey(row.agente!) === name)
        return matches.length ? matches.map(row => ({ name: row.agente!, row })) : [{ name }]
      }),
      ...observed.filter(row => !expected.includes(accountKey(row.agente!))).map(row => ({ name: row.agente!, row })),
    ]
    return { platform: p, configured: expected.length > 0, rows }
  })
  const agents = scopes.flatMap(scope => scope.rows.map(item => ({ ...item, platform: scope.platform })))
  const unconfigured = scopes.filter(scope => !scope.configured && !scope.rows.length).map(scope => scope.platform)
  // Only platform summaries: including the agent detail rows would double count.
  const summaries = platforms.flatMap(p => {
    const row = activity.find(item => item.platform === p && item.agente === null)
    return row ? [row] : []
  })
  const totalMoney = (field: 'depositos' | 'retiros' | 'bonos' | 'saldo_con_bonos') => sumProviderPesos(
    summaries.map(row => ({ platform: row.platform, value: (field === 'saldo_con_bonos' ? row.saldo_con_bonos ?? row.neto : row[field]) ?? '0' })),
  )
  return (
    <section aria-label="Movimientos por plataforma" className="mb-6 space-y-4">
      <div role="group" aria-label={platform==='consolidado'?'Total de las cuatro plataformas':`Resumen ${LABELS[platform]}`} className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {METRICS.map(({ field, label, icon: Icon, style }) => <article key={field} className={cn('surface min-w-0 p-5', field === 'saldo_con_bonos' && 'border-primary/20 bg-primary/[.045]')}>
          <div className="flex items-center gap-3">
            <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', style)}><Icon size={21} strokeWidth={1.8} aria-hidden="true" /></span>
            <h3 className="text-sm font-medium leading-snug text-muted-foreground">{label}</h3>
          </div>
          <p className="mt-4 break-words text-[clamp(1.3rem,1.65vw,1.875rem)] font-semibold leading-tight tracking-tight tabular-nums">{summaries.length?totalMoney(field):'—'}</p>
          {field==='saldo_con_bonos'&&<p className="mt-2 flex items-center gap-1.5 text-xs text-primary"><Info size={14} aria-hidden="true" />No equivale a ganancia</p>}
        </article>)}
      </div>
      <div className="surface overflow-hidden">
        <div className="space-y-1 border-b px-5 py-4">
          <h2 className="text-lg font-semibold tracking-tight">Movimientos por plataforma</h2>
          <p className="text-sm text-muted-foreground">{summaries.reduce((sum,row)=>sum+row.movimientos,0).toLocaleString('es-AR')} movimientos · {summaries.reduce((sum,row)=>sum+row.cuentas,0).toLocaleString('es-AR')} cuentas con movimientos</p>
          <p className="text-xs text-muted-foreground">{dateLabel(from)} al {dateLabel(to)} · ARS · Fechas de operación en Argentina{agent ? ` · Agente: ${agent}` : ''}</p>
        </div>
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Comparación de movimientos por plataforma</caption>
          <thead className="border-b bg-muted/40 text-xs text-muted-foreground"><tr>{['Plataforma','Depósitos sin bonos','Retiros registrados','Bonos registrados','Saldo con bonos registrados','Último movimiento'].map((label, index)=><th key={label} scope="col" className={cn('whitespace-nowrap px-5 py-3.5 font-medium', index > 0 && index < 5 ? 'text-right' : 'text-left')}>{label}</th>)}</tr></thead>
          <tbody>{scopes.map(({platform:p,configured})=>{
            const row=activity.find(item=>item.platform===p&&item.agente===null)
            const missing=!configured&&!row
            const money=(value:string|undefined)=>missing?'—':formatProviderPesos(value??'0',p)
            return <tr key={p} className="border-b last:border-0 transition-colors hover:bg-muted/25">
              <th scope="row" className="px-5 py-4 text-left font-medium"><div className="flex items-center gap-3"><span aria-hidden="true" className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg font-semibold', PLATFORM_STYLES[p])}>{LABELS[p][0]}</span><span>{LABELS[p]}<span className="mt-1 block min-w-40 text-xs font-normal leading-relaxed text-muted-foreground">{(row?.movimientos??0).toLocaleString('es-AR')} movimientos · {(row?.cuentas??0).toLocaleString('es-AR')} cuentas con movimientos</span></span></div></th>
              {[row?.depositos,row?.retiros,row?.bonos,row?.saldo_con_bonos??row?.neto].map((value,i)=><td key={i} className={cn('whitespace-nowrap px-5 py-4 text-right tabular-nums', i === 3 && 'font-medium')}>{money(value)}</td>)}
              <td className="px-5 py-4 text-xs leading-relaxed"><span className="whitespace-nowrap text-sm tabular-nums">{dateLabel(row?.ultima_fecha??null)}</span>
                {missing&&<p className="mt-1 min-w-40 text-muted-foreground">{UNCONFIGURED_ACCOUNT}.</p>}
                {!missing&&<>
                  {row?.ultima_fecha&&row.ultima_fecha<to&&<p className="mt-1 min-w-44 text-warning">El período incluye fechas posteriores sin movimientos cargados.</p>}
                  {p==='ganamos'&&!Number(row?.bonos)&&<p className="mt-1 min-w-44 text-warning">Bonos sin detalle importado. El total puede diferir del panel de origen si los incluye.</p>}
                  {!configured&&<p className="mt-1 text-warning">Hay movimientos de este agente aunque no tiene cuenta configurada en esta plataforma.</p>}
                  {!row?.movimientos&&<p className="mt-1 text-muted-foreground">No hay movimientos registrados para este período y estos filtros.</p>}
                </>}
              </td>
            </tr>
          })}</tbody>
        </table>
        </div>
        <div className="border-t bg-muted/15 px-5 py-3">
          <details className="text-xs text-muted-foreground"><summary className="cursor-pointer font-medium hover:text-foreground">Cómo interpretar estos importes</summary><p className="max-w-5xl pt-2 leading-relaxed">El saldo incluye depósitos y bonos registrados menos retiros; no equivale a ganancia. Los gráficos cuentan solamente depósitos, sin bonos. Argenbet muestra los totales originales con dos decimales truncados, como su panel; restar los importes visibles puede diferir un centavo. Los importes corresponden a movimientos cargados con plataforma identificada. La última fecha disponible abarca todo el historial y no confirma días completos ni ausencia de períodos pendientes. Una misma persona puede tener cuentas en varias plataformas.</p></details>
        </div>
      </div>
      <details className="surface overflow-hidden">
        <summary className="cursor-pointer px-5 py-4 text-sm font-medium hover:bg-muted/25">Ver movimientos y última fecha de cada agente ({agents.length})</summary>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <caption className="sr-only">Movimientos por agente del período y última fecha disponible del historial</caption>
            <thead className="border-y bg-muted/40 text-muted-foreground"><tr>{['Plataforma', 'Agente', 'Depósitos', 'Retiros', 'Saldo con bonos registrados', 'Movimientos', 'Último movimiento disponible'].map((h, index) => <th key={h} scope="col" className={cn('px-5 py-3.5 whitespace-nowrap font-medium', index > 1 && index < 6 ? 'text-right' : 'text-left')}>{h}</th>)}</tr></thead>
            <tbody>{agents.map(({ platform: p, name, row }) => <tr key={`${p}:${name}`} className="border-b last:border-0">
              <td className="px-5 py-3.5">{LABELS[p]}</td><th scope="row" className="px-5 py-3.5 text-left font-medium">{name}</th>
              <td className="px-5 py-3.5 text-right whitespace-nowrap tabular-nums">{formatProviderPesos(row?.depositos ?? '0', p)}</td>
              <td className="px-5 py-3.5 text-right whitespace-nowrap tabular-nums">{formatProviderPesos(row?.retiros ?? '0', p)}</td>
              <td className="px-5 py-3.5 text-right whitespace-nowrap tabular-nums">{formatProviderPesos(row?.saldo_con_bonos ?? row?.neto ?? '0', p)}</td>
              <td className="px-5 py-3.5 text-right tabular-nums">{(row?.movimientos ?? 0).toLocaleString('es-AR')}</td>
              <td className="px-5 py-3.5 whitespace-nowrap">{dateLabel(row?.ultima_fecha ?? null)}</td>
            </tr>)}
            {unconfigured.map(p => <tr key={`${p}:sin-cuenta`} className="border-b last:border-0">
              <td className="p-3">{LABELS[p]}</td><th scope="row" className="p-3 text-left font-medium">—</th>
              <td colSpan={5} className="p-3 text-muted-foreground">{UNCONFIGURED_ACCOUNT}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </details>
    </section>
  )
}
