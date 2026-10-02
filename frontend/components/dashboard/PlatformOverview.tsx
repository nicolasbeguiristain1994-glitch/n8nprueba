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
      <div className={`grid grid-cols-1 gap-3 ${platform === 'consolidado' ? 'sm:grid-cols-2 xl:grid-cols-5' : ''}`}>
        {scopes.map(({ platform: p, configured }) => {
          const row = activity.find(item => item.platform === p && item.agente === null)
          // Without a configured account nor observed movements a zero would read as "no activity".
          const missing = !configured && !row
          const money = (value: string | undefined) => missing ? '—' : formatProviderPesos(value ?? '0', p)
          return (
            <article key={p} className="surface p-4 space-y-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold"><span className="size-2 rounded-sm bg-primary/70" aria-hidden="true" />{LABELS[p]}</h3>
              <dl className={platform === 'consolidado' ? 'grid grid-cols-2 gap-3 text-sm sm:grid-cols-1' : 'grid grid-cols-2 gap-x-5 gap-y-4 text-sm xl:grid-cols-4'}>
                <div><dt className="text-xs text-muted-foreground">Depósitos sin bonos</dt><dd className="mt-1 text-lg font-semibold tracking-tight tabular-nums break-words">{money(row?.depositos)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Retiros registrados</dt><dd className="mt-1 text-lg font-semibold tracking-tight tabular-nums break-words">{money(row?.retiros)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Bonos registrados</dt><dd className="mt-1 text-lg font-semibold tracking-tight tabular-nums">{money(row?.bonos)}</dd></div>
                <div className={platform === 'consolidado' ? 'border-t pt-2' : 'xl:border-l xl:pl-5'}><dt className="text-xs text-muted-foreground">Saldo con bonos registrados</dt><dd className="mt-1 text-lg font-semibold tracking-tight tabular-nums break-words">{money(row?.saldo_con_bonos ?? row?.neto)}</dd></div>
              </dl>
              {missing ? <p className="text-xs text-muted-foreground">{UNCONFIGURED_ACCOUNT}.</p> : <>
                {row?.ultima_fecha && row.ultima_fecha < to && <p className="text-xs text-warning dark:text-amber-400">Último movimiento cargado: {dateLabel(row.ultima_fecha)}. El período elegido incluye fechas posteriores sin movimientos cargados.</p>}
                <details className="border-t pt-2 text-xs text-muted-foreground">
                  <summary className="cursor-pointer leading-relaxed">{(row?.movimientos ?? 0).toLocaleString('es-AR')} movimientos · {(row?.cuentas ?? 0).toLocaleString('es-AR')} cuentas con movimientos</summary>
                  <p className="pt-2">Último movimiento disponible: <strong>{dateLabel(row?.ultima_fecha ?? null)}</strong></p>
                </details>
                {p === 'ganamos' && !Number(row?.bonos) && <p className="text-xs text-warning dark:text-amber-400">Bonos sin detalle importado. El total puede diferir del panel de origen si los incluye.</p>}
                {!configured && <p className="text-xs text-warning dark:text-amber-400">Hay movimientos de este agente aunque no tiene cuenta configurada en esta plataforma.</p>}
                {!row?.movimientos && <p className="text-xs text-warning dark:text-amber-400">No hay movimientos registrados para este período y estos filtros.</p>}
              </>}
            </article>
          )
        })}
        {platform === 'consolidado' && <article aria-label="Total de las cuatro plataformas" className="min-w-0 rounded-xl border border-primary/20 bg-accent/40 p-4 space-y-3">
          <h3 className="font-semibold">Total</h3>
          <dl className="space-y-2 text-sm">
            <div><dt className="text-xs text-muted-foreground">Depósitos sin bonos</dt><dd className="font-semibold tabular-nums break-words">{totalMoney('depositos')}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Retiros registrados</dt><dd className="font-semibold tabular-nums break-words">{totalMoney('retiros')}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Bonos registrados</dt><dd className="font-semibold tabular-nums break-words">{totalMoney('bonos')}</dd></div>
            <div className="border-t border-primary/20 pt-2"><dt className="text-xs text-muted-foreground">Saldo con bonos registrados</dt><dd className="font-semibold tabular-nums break-words">{totalMoney('saldo_con_bonos')}</dd></div>
          </dl>
          <p className="text-xs text-muted-foreground">{summaries.reduce((sum, row) => sum + row.movimientos, 0).toLocaleString('es-AR')} movimientos · {summaries.reduce((sum, row) => sum + row.cuentas, 0).toLocaleString('es-AR')} cuentas con movimientos</p>
          <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Acerca de este total</summary><p className="pt-2">Suma de los importes mostrados en las cuatro plataformas, con el período y agente seleccionados. Incluye únicamente bonos registrados.</p></details>
        </article>}
      </div>
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
