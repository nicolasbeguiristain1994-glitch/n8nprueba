import type { CampaignRiskWhatsAppAlertSummary } from '@/lib/campaign-risk-alerts'

const STATUS_TEXT: Record<CampaignRiskWhatsAppAlertSummary['status'], string> = {
  pending: 'En cola', preparing: 'Preparando', skipped: 'No enviada', sending: 'Enviando', sent: 'Aceptada por WhatsApp', delivered: 'Entregada',
  read: 'Leída', blocked: 'En espera', failed: 'Falló el envío', uncertain: 'Sin confirmación',
}

export function CampaignRiskWhatsAppStatus({ alerts, unavailable }: {
  alerts: CampaignRiskWhatsAppAlertSummary[]
  unavailable: boolean
}) {
  return <section aria-label="Alerta por WhatsApp" className="space-y-2 rounded-lg border p-3">
    <h3 className="text-sm font-semibold">Alerta por WhatsApp</h3>
    {unavailable ? <p className="text-sm text-muted-foreground">No se pudo consultar el envío de la alerta. Actualizá el estado para volver a comprobarlo.</p>
      : alerts.length === 0 ? <p className="text-sm text-muted-foreground">Todavía no hay envíos de alerta registrados para esta campaña.</p>
        : <ul className="space-y-3" aria-live="polite">{alerts.map(alert => <li key={alert.id} className="space-y-1 text-sm">
          <p className="font-medium">{STATUS_TEXT[alert.status] ?? 'Estado no disponible'}</p>
          {alert.detail && <p className="text-muted-foreground">{alert.detail}</p>}
          {alert.status === 'sent' && <p className="text-muted-foreground">La entrega al teléfono aún no está confirmada.</p>}
          {alert.status === 'uncertain' && <p className="text-muted-foreground">No se reenvía automáticamente para evitar duplicados.</p>}
          {Number.isFinite(Date.parse(alert.updatedAt)) && <p className="text-xs text-muted-foreground">Actualizada: {new Date(alert.updatedAt).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })} (hora Argentina)</p>}
        </li>)}</ul>}
    <p className="text-xs text-muted-foreground">El envío de esta alerta no reanuda la campaña. El aviso también permanece en la campana del panel.</p>
  </section>
}
