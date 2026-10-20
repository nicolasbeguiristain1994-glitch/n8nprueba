import type { LineVolumeRecommendation as Recommendation } from '@/lib/line-volume-policy'

const STATUS = {
  start: { label: 'Comenzar', className: 'bg-blue-50 text-blue-800' },
  increase: { label: 'Subir', className: 'bg-success/10 text-success' },
  hold: { label: 'Mantener', className: 'bg-muted text-foreground' },
  reduce: { label: 'Bajar', className: 'bg-amber-50 text-amber-800' },
  stop: { label: 'Detener', className: 'bg-destructive/10 text-destructive' },
  unavailable: { label: 'Sin datos', className: 'bg-muted text-muted-foreground' },
} as const
const number = (value: number | null) => value === null ? '—' : value.toLocaleString('es-AR')
const percentage = (value: number | null) => value === null ? 'Sin datos' : new Intl.NumberFormat('es-AR', { style: 'percent', maximumFractionDigits: 1 }).format(value)
const dateLabel = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.split('-').reverse().join('/') : date
function timeLabel(value: string | null, timeZone: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Sin datos'
  try { return new Date(value).toLocaleString('es-AR', { timeZone, dateStyle: 'short', timeStyle: 'short' }) }
  catch { return 'Sin datos' }
}

export function LineVolumeRecommendation({ recommendation, lineName, compact = false, loading = false, onDetails }: {
  recommendation?: Recommendation
  lineName: string
  compact?: boolean
  loading?: boolean
  onDetails?: () => void
}) {
  if (!recommendation) return <div className={compact ? 'min-w-44 text-xs text-muted-foreground' : 'rounded-xl border p-4 text-sm text-muted-foreground'}>
    <p>{loading ? 'Consultando recomendación…' : 'Sin recomendación'}</p>
    {!compact && <p className="mt-1">Actualizá las líneas para volver a comprobarla.</p>}
  </div>

  const r = recommendation
  const status = STATUS[r.status] ?? STATUS.unavailable
  const progress = r.suggestedToday !== null && r.suggestedToday > 0 && r.status !== 'stop' && r.status !== 'unavailable'
    ? Math.min(100, Math.max(0, (r.attemptedToday / r.suggestedToday) * 100)) : null
  const bar = progress === null ? null : <div role="progressbar" aria-label={`Mensajes registrados hoy de ${lineName}`}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}
    aria-valuetext={`${number(r.attemptedToday)} registrados de ${number(r.suggestedToday)} sugeridos`}
    className="h-1.5 overflow-hidden rounded-full bg-muted">
    <div className={`h-full rounded-full ${r.status === 'reduce' ? 'bg-amber-500' : 'bg-primary'}`} style={{ width: `${progress}%` }} />
  </div>
  const badge = <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${status.className}`}>{status.label}</span>

  if (compact) return <div className="min-w-44 max-w-56 space-y-1.5 text-xs">
    {badge}
    {r.suggestedToday === null ? <p className="text-muted-foreground">Total sugerido: sin datos</p>
      : <p><strong className="tabular-nums">{number(r.suggestedToday)}</strong> sugeridos hoy · <strong className="tabular-nums">{number(r.remainingToday)}</strong> restantes</p>}
    {bar}
    {r.availableNow !== null && <p className="text-muted-foreground">Hasta {number(r.availableNow)} ahora</p>}
    {onDetails && <button type="button" onClick={onDetails} aria-label={`Ver recomendación de ${lineName}`}
      className="text-primary underline-offset-4 hover:underline focus-visible:underline">Ver motivo y evolución</button>}
  </div>

  const additionalReasons = [...new Set(r.reasons)].filter(reason => reason !== r.reason)
  return <section aria-label={`Recomendación de ${lineName}`} className="space-y-4 rounded-xl border border-border bg-background/80 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="text-sm font-semibold">Recomendación de hoy</h3><p className="text-xs text-muted-foreground">{dateLabel(r.date)} · {r.timeZone}</p></div>
      {badge}
    </div>
    <p className="text-sm font-medium break-words">{r.reason}</p>
    {additionalReasons.length > 0 && <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">{additionalReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
      {[
        ['Total sugerido hoy', r.suggestedToday], ['Restantes sugeridos hoy', r.remainingToday],
        ['Mensajes registrados hoy', r.attemptedToday], ['Disponibles ahora por cupo horario', r.availableNow],
        ['Aceptados por WhatsApp hoy', r.acceptedToday], ['Límite diario configurado', r.dailyLimit],
      ].map(([label, value]) => <div key={String(label)}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="font-semibold tabular-nums">{number(value as number | null)}</dd></div>)}
    </dl>
    {bar}
    <p className="text-xs text-muted-foreground">Los mensajes registrados incluyen fallos. Esta orientación no modifica los límites configurados ni inicia envíos.</p>
    {r.status !== 'stop' && r.status !== 'unavailable' && <div className="space-y-1.5 border-t pt-3">
      <h4 className="text-xs font-semibold">Condiciones para aumentar</h4>
      <p className="text-sm"><strong>{r.qualifyingDays} de {r.requiredDays} días</strong> con actividad suficiente y resultados maduros.</p>
      {r.nextHealthyDay !== null && <p className="text-sm">Próximo escalón posible: <strong>{number(r.nextHealthyDay)} mensajes por día</strong>, si se cumplen las condiciones.</p>}
      <p className="text-xs text-muted-foreground">Solo cuentan días con actividad suficiente y resultados de al menos 12 horas: 90% o más de entregas, 5% o menos de fallos, ninguna baja ni rechazo 131049. El paso del tiempo por sí solo no aumenta la sugerencia.</p>
    </div>}
    <div className="space-y-2 border-t pt-3">
      <h4 className="text-xs font-semibold">Datos usados en la evaluación</h4>
      <p className="text-xs text-muted-foreground">Entrega y fallos usan días cerrados con al menos 12 horas desde el último envío. Las bajas incluyen hoy.</p>
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div><dt className="text-muted-foreground">Muestra de días cerrados (últimos 7 días)</dt><dd>{number(r.sampleSize)} mensajes</dd></div>
        <div><dt className="text-muted-foreground">Calidad informada por Meta</dt><dd>{({ GREEN: 'Alta', YELLOW: 'Media', RED: 'Baja' } as Record<string, string>)[r.quality ?? ''] ?? 'Sin datos'}</dd></div>
        <div><dt className="text-muted-foreground">Entrega confirmada</dt><dd>{percentage(r.deliveryRate)}</dd></div>
        <div><dt className="text-muted-foreground">Fallos</dt><dd>{percentage(r.failureRate)}</dd></div>
        <div><dt className="text-muted-foreground">Solicitudes de baja</dt><dd>{number(r.optOuts)}</dd></div>
      </dl>
    </div>
    {r.recentDays.length > 0 && <details className="border-t pt-3">
      <summary className="cursor-pointer text-xs font-semibold">Ver actividad de los días recientes</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-right text-xs tabular-nums">
          <caption className="sr-only">Actividad diaria registrada de {lineName}</caption>
          <thead><tr className="border-b">{['Día', 'Registrados', 'Aceptados', 'Entregados', 'Fallidos', 'Bajas', 'Rechazos 131049', 'Sin resultado'].map(label => <th scope="col" key={label} className="whitespace-nowrap px-2 py-2 font-medium">{label}</th>)}</tr></thead>
          <tbody>{[...r.recentDays].sort((a, b) => b.date.localeCompare(a.date)).map(day => <tr key={day.date} className="border-b last:border-0">
            {[dateLabel(day.date), day.attempted, day.accepted, day.delivered, day.failed, day.optOuts, day.ecosystemRejected, day.unknown ?? '—'].map((value, index) => <td key={index} className="whitespace-nowrap px-2 py-2">{typeof value === 'number' ? number(value) : value}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
    </details>}
    <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
      <p>Última evaluación: {timeLabel(r.evaluatedAt, r.timeZone)}</p>
      <p>Último control de Meta: {timeLabel(r.lastMetaCheckAt, r.timeZone)}</p>
      <p>Orientación interna; no garantiza evitar restricciones. Respetá el cupo compartido de Meta y el consentimiento.</p>
    </div>
  </section>
}
