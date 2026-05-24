import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { isUUID } from '@/lib/validate'
import { checkPermission } from '@/lib/permissions'
import { getAgentsForPlatform } from '@/lib/casino-agents'

// Strips platform prefixes like "Z/ ", "ZS/ ", "Zeus/ " from stored first_name
// so the raw casino username can be matched against casino_players.username_lower
function extractUsername(s: string): string {
  return s.replace(/^[a-zA-Z]+\/\s*/, '').trim().toLowerCase()
}

// Sourced from casino-agents.ts — single source of truth for agent lists
const ZEUS_AGENTS  = getAgentsForPlatform('zeus')
const BET30_AGENTS = getAgentsForPlatform('bet30')

// Platform detection regexes (match on the end of the username string)
// ZEUS_RE: matches z, z2, z3, zs, zs2, zeus — the digit suffix appears in some agent tables
const ZEUS_RE  = /z(s|eus)?\d*$/i
const BET30_RE = /b(t)?\d*$/i

interface PlatformStats {
  monto_cargas_mes:  number
  monto_retiros_mes: number
  last_deposit_at:   string | null
  mes_referencia:    string | null
  fuente:            'transactions' | 'historico'
}

async function queryPlatformStats(
  usernames: string[],
  agents:    string[],
): Promise<PlatformStats | null> {
  if (!usernames.length) return null

  const cpRows = await query<{ username: string; total_cargas: number; fecha_ultima: string | null }>(
    `SELECT username, total_cargas, fecha_ultima
     FROM casino_players
     WHERE username_lower = ANY($1::text[])
       AND agente         = ANY($2::text[])
     LIMIT 1`,
    [usernames, agents],
  )
  if (!cpRows.length) return null

  const uname = cpRows[0].username.toLowerCase()

  const txRows = await query<{
    monto_cargas_mes:  number
    monto_retiros_mes: number
    last_deposit_at:   string | null
    mes_referencia:    string | null
  }>(`
    WITH ultimo_mes AS (
      SELECT DATE_TRUNC('month', MAX(fecha)) AS mes
      FROM casino_transactions
      WHERE LOWER(username) = $1
    )
    SELECT
      COALESCE(SUM(CASE WHEN ct.tipo = 'carga'  AND DATE_TRUNC('month', ct.fecha) = um.mes THEN ct.monto      ELSE 0 END), 0)::int AS monto_cargas_mes,
      COALESCE(SUM(CASE WHEN ct.tipo = 'retiro' AND DATE_TRUNC('month', ct.fecha) = um.mes THEN ABS(ct.monto) ELSE 0 END), 0)::int AS monto_retiros_mes,
      MAX(CASE WHEN ct.tipo = 'carga' THEN ct.fecha END) AS last_deposit_at,
      TO_CHAR(um.mes, 'Mon YYYY') AS mes_referencia
    FROM casino_transactions ct
    CROSS JOIN ultimo_mes um
    WHERE LOWER(ct.username) = $1
      AND um.mes IS NOT NULL
    GROUP BY um.mes
  `, [uname])

  if (txRows.length > 0 && (txRows[0].monto_cargas_mes > 0 || txRows[0].monto_retiros_mes > 0)) {
    return { ...txRows[0], fuente: 'transactions' }
  }

  return {
    monto_cargas_mes:  cpRows[0].total_cargas ?? 0,
    monto_retiros_mes: 0,
    last_deposit_at:   cpRows[0].fecha_ultima ?? null,
    mes_referencia:    null,
    fuente:            'historico',
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const err = await checkPermission(req, 'contacts', 'read')
  if (err) return err

  const { id } = await params
  if (!isUUID(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const empty = { monto_cargas_mes: 0, monto_retiros_mes: 0, last_deposit_at: null, mes_referencia: null, fuente: null, bet30: null }

  try {
    const [contact] = await query<{ first_name: string | null; last_name: string | null }>(
      'SELECT first_name, last_name FROM contacts WHERE id = $1', [id]
    )
    if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })

    // Build candidates: tokenize by common separators (spaces, //, |, etc.)
    // so compound first_names like "dani457zzz (Chantaaa)" or "user//alias" work correctly.
    const raw = [contact.first_name, contact.last_name]
    const candidates = [...new Set(
      raw
        .filter(Boolean)
        .flatMap(s => {
          const clean = s!.trim().toLowerCase()
          const tokens = clean.split(/[\s/|,;.()\[\]]+/).filter(t => t.length > 0)
          return [clean, extractUsername(s!), ...tokens]
        })
        .filter(s => s.length > 0)
    )]

    if (candidates.length === 0) return NextResponse.json(empty)

    // Split candidates by platform based on username suffix
    const zeusUsernames  = candidates.filter(u => ZEUS_RE.test(u))
    const bet30Usernames = candidates.filter(u => BET30_RE.test(u))

    // Query both platforms in parallel
    const [zeusStats, bet30Stats] = await Promise.all([
      queryPlatformStats(zeusUsernames,  ZEUS_AGENTS),
      queryPlatformStats(bet30Usernames, BET30_AGENTS),
    ])

    // Primary stats = zeus if found, otherwise bet30
    const primary = zeusStats ?? bet30Stats
    if (!primary) return NextResponse.json(empty)

    // bet30 key is only populated when the contact has BOTH platforms
    // (so the view modal knows to show a separate Bet30 section)
    const bet30Field = zeusStats && bet30Stats ? bet30Stats : null

    return NextResponse.json({ ...primary, bet30: bet30Field })
  } catch (e) {
    console.error('[/api/contacts/[id]/casino-stats]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
