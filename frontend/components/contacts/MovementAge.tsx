interface MovementAgeProps {
  days?: number | null
  date?: string | null
  loading?: boolean
  error?: boolean
}

export function MovementAge({ days, date, loading, error }: MovementAgeProps) {
  if (loading) return <span className="text-xs text-muted-foreground" aria-label="Cargando movimientos">Cargando…</span>
  if (error) return <span className="text-xs text-muted-foreground" title="Usá Actualizar contactos para volver a cargar el historial.">No disponible</span>
  if (days == null) return <span className="text-xs text-muted-foreground" title="No hay cargas ni retiros identificables en las cuentas vinculadas.">Sin movimientos registrados</span>
  if (days < 0) return <span className="text-xs text-muted-foreground" title={`Último movimiento: ${date}. Revisar la fecha del registro.`}>Fecha futura</span>
  const formatted = date?.split('-').reverse().join('/')
  return <span className="whitespace-nowrap tabular-nums" title={`Última carga o retiro: ${formatted || 'sin fecha'}. Días calendario de Argentina; todas las cuentas vinculadas.`}>{days} {days === 1 ? 'día' : 'días'}</span>
}
