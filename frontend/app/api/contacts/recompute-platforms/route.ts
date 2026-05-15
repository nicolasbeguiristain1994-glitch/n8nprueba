import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { getAgentsForPlatform } from '@/lib/casino-agents'

// POST /api/contacts/recompute-platforms
//
// Recalculates the `platforms` column for all contacts in a single batch query.
// Only updates rows where the computed value differs from the stored value.
//
// When to call:
//   After a casino sync that may have added new bet30 players to casino_players,
//   because the trigger only fires on INSERT/UPDATE of contacts — it doesn't
//   react to changes in casino_players.
//
// Access: admin only.

export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'contacts', 'manage')
  if (err) return err

  try {
    const bet30Agents = getAgentsForPlatform('bet30')

    const result = await query<{ updated: string }>(`
      WITH computed AS (
        SELECT
          id,
          ARRAY_REMOVE(ARRAY[
            CASE WHEN first_name ~* 'z(s|eus)?$' OR last_name ~* 'z(s|eus)?$'
                 THEN 'zeus' END,
            CASE WHEN (first_name ~* 'b(t)?$' OR last_name ~* 'b(t)?$')
                 AND EXISTS (
                   SELECT 1 FROM casino_players cp
                   WHERE cp.username_lower = ANY(ARRAY[
                     LOWER(TRIM(COALESCE(first_name, ''))),
                     REGEXP_REPLACE(LOWER(TRIM(COALESCE(first_name, ''))), '^[a-z]+/\\s*', ''),
                     LOWER(TRIM(COALESCE(last_name,  ''))),
                     REGEXP_REPLACE(LOWER(TRIM(COALESCE(last_name,  ''))), '^[a-z]+/\\s*', '')
                   ])
                   AND cp.agente = ANY($1::text[])
                 )
                 THEN 'bet30' END
          ], NULL) AS new_platforms
        FROM contacts
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
    `, [bet30Agents])

    const updated = Number(result[0]?.updated ?? 0)
    console.log(`[recompute-platforms] Updated ${updated} contacts`)

    return NextResponse.json({ ok: true, updated })
  } catch (e) {
    console.error('[/api/contacts/recompute-platforms]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
