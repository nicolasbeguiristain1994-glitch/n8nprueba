import type { CampaignSelectionSummary } from '@/lib/campaign-selection'

export function SelectedContactsAudience({ count, summary, error, onRetry }: {
  count: number; summary: CampaignSelectionSummary | null; error: string | null; onRetry: () => void
}) {
  return <div className="rounded-xl border border-primary/25 bg-accent/40 p-4 space-y-3">
    <div><h3 className="font-semibold">Contactos seleccionados</h3>
      <p className="text-sm text-muted-foreground">{count.toLocaleString('es-AR')} seleccionados desde Contactos. Esta campaña conserva esta selección.</p></div>
    {error ? <p role="alert" className="text-sm text-destructive">{error} <button type="button" className="underline" onClick={onRetry}>Reintentar revisión</button></p>
      : !summary ? <p role="status" className="text-sm text-muted-foreground">Revisando destinatarios…</p>
      : <><dl className="grid grid-cols-2 gap-3 text-sm">
        <div><dt className="text-muted-foreground">Habilitados</dt><dd className="text-xl font-semibold">{summary.eligible.toLocaleString('es-AR')}</dd></div>
        <div><dt className="text-muted-foreground">Excluidos</dt><dd className="text-xl font-semibold">{summary.excluded.toLocaleString('es-AR')}</dd></div>
      </dl>
      {summary.excluded > 0 && <p className="text-xs text-muted-foreground">{[
        summary.blacklisted && `${summary.blacklisted} en Blacklist`, summary.inactive && `${summary.inactive} inactivos`,
        summary.opted_out && `${summary.opted_out} con baja o sin permiso de marketing`, summary.duplicates && `${summary.duplicates} con teléfono repetido`,
      ].filter(Boolean).join(' · ')}</p>}
      {summary.eligible === 0 && <p role="alert" className="text-sm text-destructive">No hay contactos habilitados. Volvé a Contactos y cambiá la selección.</p>}
      <p className="text-xs text-muted-foreground">Cada teléfono se incluye una sola vez. Las bajas y los bloqueos se vuelven a comprobar antes del envío.</p></>}
  </div>
}
