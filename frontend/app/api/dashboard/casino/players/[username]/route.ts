import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'

const MAX_LABELS     = 10
const MAX_LABEL_LEN  = 40
const LABEL_PATTERN  = /^[a-zA-Z0-9áéíóúÁÉÍÓÚñÑüÜ\s\-_]+$/

/**
 * PATCH /api/dashboard/casino/players/[username]
 *
 * Actualiza las etiquetas operativas de un jugador de casino.
 * Body: { labels: string[] }
 *
 * Las labels se almacenan en casino_players.labels (TEXT[]).
 * No requiere que el jugador tenga un contacto asociado.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ username: string }> },
) {
  const err = await checkPermission(req, 'dashboard', 'read')
  if (err) return err

  const { username } = await params
  const decoded = decodeURIComponent(username).trim()
  if (!decoded) return NextResponse.json({ error: 'Username inválido' }, { status: 400 })

  let body: { labels?: unknown }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const raw = body.labels
  if (!Array.isArray(raw)) {
    return NextResponse.json({ error: 'labels debe ser un array' }, { status: 400 })
  }

  // Validar cada label
  const labels: string[] = []
  for (const l of raw) {
    if (typeof l !== 'string') continue
    const t = l.trim()
    if (!t) continue
    if (t.length > MAX_LABEL_LEN)
      return NextResponse.json({ error: `Label demasiado larga: "${t}"` }, { status: 400 })
    if (!LABEL_PATTERN.test(t))
      return NextResponse.json({ error: `Label contiene caracteres inválidos: "${t}"` }, { status: 400 })
    labels.push(t)
  }

  if (labels.length > MAX_LABELS) {
    return NextResponse.json({ error: `Máximo ${MAX_LABELS} etiquetas por jugador` }, { status: 400 })
  }

  try {
    const rows = await query<{ labels: string[] }>(
      `UPDATE casino_players
         SET labels = $1
       WHERE username_lower = LOWER($2)
       RETURNING labels`,
      [labels, decoded],
    )

    if (!rows.length) {
      return NextResponse.json({ error: 'Jugador no encontrado' }, { status: 404 })
    }

    return NextResponse.json({ ok: true, labels: rows[0].labels })
  } catch (e) {
    console.error('[casino/players/[username] PATCH]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
