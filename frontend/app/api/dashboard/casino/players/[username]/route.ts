import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { parseBody, handleValidationError, UpdateCasinoPlayerSchema } from '@/lib/schema'
import { isValidPlatform } from '@/lib/casino-agents'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ username: string }> },
) {
  const err = await checkPermission(req, 'dashboard', 'read')
  if (err) return err

  const { username } = await params
  const decoded = decodeURIComponent(username).trim()
  if (!decoded) return NextResponse.json({ error: 'Username inválido' }, { status: 400 })

  // D2/H bloqueante (revisión coordinador, mensaje 7): username_lower ya no es
  // único global — el mismo username puede existir en más de una plataforma
  // (fila con platform NULL para el histórico ambiguo). `platform` es
  // OBLIGATORIO: nunca se permite una mutación que pueda tocar más de una fila.
  // 'consolidado' no es una plataforma real (es la vista agregada del
  // dashboard) y se rechaza explícitamente como destino de escritura — el
  // caller debe usar la plataforma de la fila que el usuario efectivamente
  // está editando, no el selector consolidado.
  const platformParam = req.nextUrl.searchParams.get('platform')?.trim() || null
  if (!platformParam) {
    return NextResponse.json(
      { error: 'Falta el parámetro "platform": requerido para identificar la fila exacta (el username puede existir en más de una plataforma)' },
      { status: 400 },
    )
  }
  if (platformParam === 'consolidado' || !isValidPlatform(platformParam)) {
    return NextResponse.json({ error: `Plataforma inválida: "${platformParam}"` }, { status: 400 })
  }

  const rawBody = await req.json().catch(() => null)
  const parsed  = parseBody(UpdateCasinoPlayerSchema, rawBody)
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'casino-players')

  const { labels } = parsed.data

  try {
    const rows = await query<{ labels: string[]; platform: string | null }>(
      `UPDATE casino_players
         SET labels = $1
       WHERE username_lower = LOWER($2)
         AND platform = $3
       RETURNING labels, platform`,
      [labels, decoded, platformParam],
    )

    if (!rows.length) {
      return NextResponse.json({ error: 'Jugador no encontrado' }, { status: 404 })
    }

    void audit({ req, action: 'update', resource: 'casino-players', resource_id: decoded,
      metadata: { labels, platform: platformParam } })
    return NextResponse.json({
      ok:     true,
      labels: rows[0].labels,
      platform: rows[0].platform,
    })
  } catch (e) {
    console.error('[casino/players/[username] PATCH]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
