import { query } from '@/lib/db'
import { clampTracking, type Question } from '@/lib/encuestas'
import { Card, CardContent } from '@/components/ui/card'
import { EncuestaForm } from './EncuestaForm'

// Ruta dinámica — depende de query params y de la fila activa.
export const dynamic = 'force-dynamic'

type SearchParams = Promise<{
  slug?:    string
  campana?: string
  source?:  string
  player?:  string
}>

interface EncuestaRow {
  slug:        string
  title:       string
  description: string | null
  questions:   Question[]
}

export default async function EncuestaPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams

  // Prioridad: ?slug=... → si no viene, la primera activa (ordenada por created_at desc).
  const requestedSlug =
    typeof sp.slug === 'string' && /^[a-z0-9][a-z0-9-]{1,63}$/.test(sp.slug)
      ? sp.slug
      : null

  const rows = requestedSlug
    ? await query<EncuestaRow>(
        `SELECT slug, title, description, questions
           FROM encuestas
          WHERE slug = $1 AND is_active = true
          LIMIT 1`,
        [requestedSlug],
      )
    : await query<EncuestaRow>(
        `SELECT slug, title, description, questions
           FROM encuestas
          WHERE is_active = true
          ORDER BY created_at DESC
          LIMIT 1`,
      )

  const encuesta = rows[0]

  if (!encuesta) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <h1 className="font-heading text-lg font-medium mb-2">Encuesta no disponible</h1>
          <p className="text-sm text-muted-foreground">
            Volvé a intentar más tarde. ¡Gracias!
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <EncuestaForm
      slug={encuesta.slug}
      title={encuesta.title}
      description={encuesta.description}
      questions={encuesta.questions}
      campaign={clampTracking(sp.campana)}
      source={clampTracking(sp.source)}
      playerToken={typeof sp.player === 'string' ? sp.player.slice(0, 128) : null}
    />
  )
}
