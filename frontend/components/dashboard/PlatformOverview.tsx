'use client'

import { SYNC_PLATFORMS, type Platform, type SyncPlatform } from '@/lib/casino-agents'
import { configuredAgentAccounts } from '@/lib/dashboard-scope'
import { formatProviderPesos, sumProviderPesos } from '@/lib/dashboard-format'
import type { PlatformActivity } from '@/lib/dashboard-overview'

const LABELS: Record<SyncPlatform, string> = { zeus: 'Zeus', bet30: 'Bet30', ganamos: 'Ganamos', argenbet: 'Argenbet' }
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
    <section aria-label="Movimientos por plataforma" className="mb-5 space-y-3">
      <div>
        <h2 className="text-base font-semibold">Movimientos por plataforma</h2>
        <p className="text-xs text-muted-foreground">{dateLabel(from)} al {dateLabel(to)} · ARS · Fechas de operación en Argentina{agent ? ` · Agente: ${agent}` : ''}</p>
      </div>
      <div role="group" aria-label={platform==='consolidado'?'Total de las cuatro plataformas':`Resumen ${LABELS[platform]}`} className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {([['depositos','Depósitos sin bonos'],['retiros','Retiros registrados'],['bonos','Bonos registrados'],['saldo_con_bonos','Saldo con bonos registrados']] as const).map(([field,label])=><article key={field} className="surface px-4 py-3">
          <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
          <p className="mt-2 break-words text-xl font-semibold tracking-tight tabular-nums">{summaries.length?totalMoney(field):'—'}</p>
          {field==='saldo_con_bonos'&&<p className="mt-1 text-xs text-muted-foreground">No equivale a ganancia</p>}
        </article>)}
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <caption className="sr-only">Comparación de movimientos por plataforma</caption>
          <thead className="border-b bg-muted/50 text-xs text-muted-foreground"><tr>{['Plataforma','Depósitos sin bonos','Retiros registrados','Bonos registrados','Saldo con bonos registrados','Último movimiento'].map(label=><th key={label} scope="col" className="whitespace-nowrap px-4 py-3 text-left font-medium">{label}</th>)}</tr></thead>
          <tbody>{scopes.map(({platform:p,configured})=>{
            const row=activity.find(item=>item.platform===p&&item.agente===null)
            const missing=!configured&&!row
            const money=(value:string|undefined)=>missing?'—':formatProviderPesos(value??'0',p)
            return <tr key={p} className="border-b last:border-0 hover:bg-muted/20">
              <th scope="row" className="px-4 py-3 text-left font-medium">{LABELS[p]}<span className="mt-1 block whitespace-nowrap text-xs font-normal text-muted-foreground">{(row?.movimientos??0).toLocaleString('es-AR')} movimientos · {(row?.cuentas??0).toLocaleString('es-AR')} cuentas con movimientos</span></th>
              {[row?.depositos,row?.retiros,row?.bonos,row?.saldo_con_bonos??row?.neto].map((value,i)=><td key={i} className="whitespace-nowrap px-4 py-3 tabular-nums">{money(value)}</td>)}
              <td className="px-4 py-3 text-xs"><span className="whitespace-nowrap">{dateLabel(row?.ultima_fecha??null)}</span>
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
      <p className="text-xs text-muted-foreground">{summaries.reduce((sum,row)=>sum+row.movimientos,0).toLocaleString('es-AR')} movimientos · {summaries.reduce((sum,row)=>sum+row.cuentas,0).toLocaleString('es-AR')} cuentas con movimientos. Totales del período y agente seleccionados, con bonos registrados.</p>
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer py-1 font-medium">Cómo interpretar estos importes</summary><p className="pt-1 leading-relaxed">El saldo incluye depósitos y bonos registrados menos retiros; no equivale a ganancia. Los gráficos cuentan solamente depósitos, sin bonos. Argenbet muestra los totales originales con dos decimales truncados, como su panel; restar los importes visibles puede diferir un centavo. Los importes corresponden a movimientos cargados con plataforma identificada. La última fecha disponible abarca todo el historial y no confirma días completos ni ausencia de períodos pendientes. Una misma persona puede tener cuentas en varias plataformas.</p></details>
      <details className="rounded-xl border bg-card">
        <summary className="cursor-pointer p-3 text-sm font-medium">Ver movimientos y última fecha de cada agente ({agents.length})</summary>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <caption className="sr-only">Movimientos por agente del período y última fecha disponible del historial</caption>
            <thead className="border-y bg-muted text-left"><tr>{['Plataforma', 'Agente', 'Depósitos', 'Retiros', 'Saldo con bonos registrados', 'Movimientos', 'Último movimiento disponible'].map(h => <th key={h} scope="col" className="p-3 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>{agents.map(({ platform: p, name, row }) => <tr key={`${p}:${name}`} className="border-b last:border-0">
              <td className="p-3">{LABELS[p]}</td><th scope="row" className="p-3 text-left font-medium">{name}</th>
              <td className="p-3 whitespace-nowrap tabular-nums">{formatProviderPesos(row?.depositos ?? '0', p)}</td>
              <td className="p-3 whitespace-nowrap tabular-nums">{formatProviderPesos(row?.retiros ?? '0', p)}</td>
              <td className="p-3 whitespace-nowrap tabular-nums">{formatProviderPesos(row?.saldo_con_bonos ?? row?.neto ?? '0', p)}</td>
              <td className="p-3 tabular-nums">{(row?.movimientos ?? 0).toLocaleString('es-AR')}</td>
              <td className="p-3 whitespace-nowrap">{dateLabel(row?.ultima_fecha ?? null)}</td>
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
