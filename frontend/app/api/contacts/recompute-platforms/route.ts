import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'

// POST /api/contacts/recompute-platforms
//
// Recalculates the `platforms` column for all contacts in a single batch query.
// Only updates rows where the computed value differs from the stored value.
//
// Zeus detection:
//   1. Regex: first_name or last_name ends in z / ze / zs / zeus
//   2. OR: any token in the name field exists in casino_players with a Zeus agent
//      (catches f/ff suffix users and multi-username fields like "User99z Surname")
// Bet30 detection:
//   Regex only: first_name or last_name ends in b / bt
//   (casino_players has no bet30 agent data)
//
// Access: admin only.

const ZEUS_AGENTS = ['bigwin', 'ofizeus', 'betcoin', 'royal', 'farabet']

export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'contacts', 'manage')
  if (err) return err

  try {
    const result = await query<{ updated: string }>(`
      WITH computed AS (
        SELECT
          c.id,
          ARRAY_REMOVE(ARRAY[
            CASE WHEN
              c.first_name ~* 'z(e|s|eus)?$' OR c.last_name ~* 'z(e|s|eus)?$'
              OR EXISTS (
                SELECT 1
                FROM casino_players cp
                JOIN LATERAL unnest(
                  regexp_split_to_array(
                    COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''),
                    '[\\s/\\\\|,;]+'
                  )
                ) AS tok ON true
                WHERE LENGTH(tok) > 2
                  AND cp.username_lower = LOWER(tok)
                  AND cp.agente = ANY($1::text[])
              )
            THEN 'zeus' END,
            CASE WHEN c.first_name ~* 'b(t)?$' OR c.last_name ~* 'b(t)?$'
                 THEN 'bet30' END
          ], NULL) AS new_platforms
        FROM contacts c
      ),
      updated AS (
        UPDATE contacts c
        SET    platforms  = computed.new_platforms,
               updated_at = NOW()
        FROM   computed
        WHERE  c.id = computed.id
          AND  c.platforms IS DISTINCT FROM computed.new_platforms
        RETURNING c.id
      )
      SELECT COUNT(*)::text AS updated FROM updated
    `, [ZEUS_AGENTS])

    const updated = Number(result[0]?.updated ?? 0)
    console.log(`[recompute-platforms] Updated ${updated} contacts`)

    return NextResponse.json({ ok: true, updated })
  } catch (e) {
    console.error('[/api/contacts/recompute-platforms]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
