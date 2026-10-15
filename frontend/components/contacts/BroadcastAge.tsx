interface BroadcastAgeProps {
  days?: number | null
  sentAt?: string | null
}

const dateFormat = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires',
  dateStyle: 'short', timeStyle: 'short',
})

export function BroadcastAge({ days, sentAt }: BroadcastAgeProps) {
  if (days == null) return <span className="whitespace-nowrap text-xs text-muted-foreground">Sin difusión</span>
  const date = sentAt ? new Date(sentAt) : null
  const title = date && Number.isFinite(date.getTime())
    ? `Última difusión: ${dateFormat.format(date)} (hora argentina). Días completos desde el envío.`
    : 'Días completos desde la última difusión.'
  return <span className="whitespace-nowrap tabular-nums" title={title}>{days} {days === 1 ? 'día' : 'días'}</span>
}
