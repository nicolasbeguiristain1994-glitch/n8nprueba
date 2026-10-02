import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { parseBody, handleValidationError, UpdateCasinoPlayerSchema } from '@/lib/schema'
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ username: string }> },
) {
  const err = await checkPermission(req, 'dashboard', 'read')
  if (err) return err

  const { username } = await params
  const decoded = decodeURIComponent(username).trim()
  if (!decoded) return NextResponse.json({ error: 'Username inválido' }, { status: 400 })

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(UpdateCasinoPlayerSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'casino-players')

  const { labels } = parsed.data

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

    void audit({ req, action: 'update', resource: 'casino-players', resource_id: decoded,
      metadata: { labels } })
    return NextResponse.json({ ok: true, labels: rows[0].labels })
  } catch (e) {
    console.error('[casino/players/[username] PATCH]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
