import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { CampaignResponseSummary } from '@/lib/campaign-response-summary'

export function CampaignResponsesPanel({ summary }: { summary: CampaignResponseSummary }) {
  return <Card className="border border-border">
    <CardHeader className="pb-3">
      <CardTitle className="text-sm font-medium">Respuestas de la campaña</CardTitle>
      <p className="text-sm text-muted-foreground">{summary.personas.toLocaleString('es-AR')} personas respondieron</p>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {summary.opciones.map(option => <div key={option.label} className={`rounded-lg border p-4 min-w-0 ${option.label === 'BAJA' ? 'border-destructive/20 bg-destructive/5' : 'border-border bg-muted/30'}`}>
          <p className="text-sm font-medium break-words">{option.label}</p>
          <p className="text-2xl font-semibold mt-2">{option.personas.toLocaleString('es-AR')} <span className="text-sm font-normal text-muted-foreground">personas</span></p>
          <p className="text-xs text-muted-foreground mt-1">{option.mensajes.toLocaleString('es-AR')} mensajes</p>
        </div>)}
      </div>
      <p className="text-xs text-muted-foreground">Cada número cuenta una vez por opción, aunque responda varias veces. Si responde opciones distintas, aparece en ambas. Se reconocen los botones de la plantilla y el mismo texto escrito; el resto se agrupa en Otras respuestas.</p>
    </CardContent>
  </Card>
}
