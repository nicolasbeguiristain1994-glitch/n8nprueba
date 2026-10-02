export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="space-y-6 py-2">
      <span className="sr-only">Cargando página…</span>
      <div aria-hidden="true" className="space-y-3 animate-pulse">
        <div className="h-7 w-48 rounded bg-muted" />
        <div className="h-4 w-72 max-w-full rounded bg-muted" />
        <div className="mt-6 h-10 rounded bg-muted" />
        <div className="h-64 rounded-xl border border-border bg-muted/40" />
      </div>
    </div>
  )
}
