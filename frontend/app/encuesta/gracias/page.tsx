import { Card, CardContent } from '@/components/ui/card'
import { CheckCircle2, User2, Mail } from 'lucide-react'

export default function GraciasPage() {
  return (
    <Card>
      <CardContent className="py-8 sm:py-10 text-center flex flex-col items-center gap-4">
        <div className="rounded-full bg-primary/10 p-3">
          <CheckCircle2 className="size-8 text-primary" />
        </div>
        <div className="space-y-1">
          <h1 className="font-heading text-xl sm:text-2xl font-medium">¡Gracias por ayudarnos a mejorar!</h1>
          <p className="text-sm text-muted-foreground">
            Leemos todo lo que nos dejás. Nos vemos en la próxima jugada.
          </p>
        </div>

        <div className="w-full mt-2 space-y-2 text-left">
          <InfoRow
            icon={<User2 className="size-4 text-primary" />}
            title="Tu username"
            body="Lo asociamos a tu cuenta para poder darte bonos. Si te aplica alguna promo, te vas a enterar por los canales oficiales."
          />
          <InfoRow
            icon={<Mail className="size-4 text-primary" />}
            title="Tu email (si lo dejaste)"
            body="Sólo lo usamos para mandarte info relevante del casino. Podés pedirnos que lo eliminemos cuando quieras."
          />
        </div>
      </CardContent>
    </Card>
  )
}

function InfoRow({
  icon, title, body,
}: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
      <div className="mt-0.5">{icon}</div>
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground leading-relaxed">{body}</p>
      </div>
    </div>
  )
}
