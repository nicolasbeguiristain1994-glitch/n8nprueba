import { query, withTransaction } from '@/lib/db'

/** Same scope as campaign ownership; permissions are still checked at dispatch. */
export const ROUTING_SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000'

/**
 * Reserve senders before any provider request. Serialize only allocation (never
 * network I/O), so overlapping campaigns/workers cannot choose different senders
 * for the same phone. Existing senders win over balancing and survive retries.
 * A NULL sender was deleted: recover surviving history or allocate a new sender.
 */
export async function prepareCampaignRouting(campaignId: string, eligibleLineIds: string[]): Promise<void> {
  const lineIds = [...new Set(eligibleLineIds)].sort()
  if (!lineIds.length) return
  await withTransaction(async client => {
    const { rows: [campaign] } = await client.query<{ owned_by: string | null }>(
      'SELECT owned_by FROM campaigns WHERE id=$1', [campaignId],
    )
    if (!campaign) throw new Error('Campaign not found for routing')
    const owner = campaign.owned_by ?? ROUTING_SYSTEM_OWNER
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 138))', [owner])

    // Recover the most recent successful contact, including the native Cloud
    // inbox. Inactive/disabled/out-of-quota historic lines must still be remembered.
    // Only accessible Cloud/legacy lines can seed a new assignment for this owner.
    await client.query(`
      WITH missing AS MATERIALIZED (
        SELECT DISTINCT regexp_replace(cr.phone_number, '[^0-9]', '', 'g') AS phone
        FROM campaign_recipients cr
        WHERE cr.campaign_id=$1 AND cr.status IN ('pending','sending')
          AND NOT EXISTS (SELECT 1 FROM campaign_line_assignments a
            WHERE a.owner_key=$2 AND a.phone=regexp_replace(cr.phone_number, '[^0-9]', '', 'g')
              AND a.line_id IS NOT NULL)
      ), visible AS MATERIALIZED (
        SELECT wl.id FROM whatsapp_lines wl
        WHERE $3::uuid IS NULL OR wl.id IN (SELECT get_accessible_line_ids($3::uuid))
      ), history AS (
        SELECT m.phone, cr.line_id, COALESCE(cr.sent_at, cr.updated_at) AS at
        FROM missing m JOIN campaign_recipients cr
          ON regexp_replace(cr.phone_number, '[^0-9]', '', 'g')=m.phone
        JOIN campaigns c ON c.id=cr.campaign_id
        JOIN visible v ON v.id=cr.line_id
        WHERE cr.status='sent' AND cr.line_id IS NOT NULL
          AND COALESCE(c.owned_by, '${ROUTING_SYSTEM_OWNER}'::uuid)=$2
        UNION ALL
        SELECT m.phone, cn.whatsapp_line_id, COALESCE(cm.sent_at, cm.created_at)
        FROM missing m JOIN cloud_conversations cv
          ON regexp_replace(cv.contact_phone, '[^0-9]', '', 'g')=m.phone
        JOIN cloud_messages cm ON cm.conversation_id=cv.id
        JOIN cloud_numbers cn ON cn.phone_number_id=cm.phone_number_id
        JOIN visible v ON v.id=cn.whatsapp_line_id
        WHERE cm.direction IN ('outbound','echo') AND cm.status IN ('sent','delivered','read')
        UNION ALL
        SELECT m.phone, p.line_id, p.updated_at
        FROM missing m JOIN phone_line_assignments p
          ON regexp_replace(p.phone, '[^0-9]', '', 'g')=m.phone
        JOIN visible v ON v.id=p.line_id
      )
      INSERT INTO campaign_line_assignments AS assignment(owner_key,phone,line_id,source)
      SELECT DISTINCT ON (phone) $2,phone,line_id,'history' FROM history
      ORDER BY phone, at DESC NULLS LAST, line_id
      ON CONFLICT (owner_key,phone) DO UPDATE
        SET line_id=EXCLUDED.line_id, source=EXCLUDED.source, assigned_at=NOW()
        WHERE assignment.line_id IS NULL`, [campaignId, owner, campaign.owned_by])

    await client.query(`INSERT INTO campaign_line_rotation(owner_key) VALUES($1)
      ON CONFLICT (owner_key) DO NOTHING`, [owner])
    // One assignment per normalized destination, even across contact/prospect
    // records. Equal rotation is for new destinations; history has priority.
    await client.query(`
      WITH missing AS (
        SELECT DISTINCT regexp_replace(cr.phone_number, '[^0-9]', '', 'g') AS phone
        FROM campaign_recipients cr
        WHERE cr.campaign_id=$1 AND cr.status IN ('pending','sending')
          AND NOT EXISTS (SELECT 1 FROM campaign_line_assignments a
            WHERE a.owner_key=$2 AND a.phone=regexp_replace(cr.phone_number, '[^0-9]', '', 'g')
              AND a.line_id IS NOT NULL)
      ), numbered AS (
        SELECT phone, ROW_NUMBER() OVER (ORDER BY phone)-1 AS n FROM missing
      ), allocated AS (
        INSERT INTO campaign_line_assignments AS assignment(owner_key,phone,line_id,source)
        SELECT $2, n.phone,
          ($3::uuid[])[((r.next_position+n.n) % cardinality($3::uuid[])+1)::int], 'rotation'
        FROM numbered n CROSS JOIN campaign_line_rotation r WHERE r.owner_key=$2
        ON CONFLICT (owner_key,phone) DO UPDATE
          SET line_id=EXCLUDED.line_id, source=EXCLUDED.source, assigned_at=NOW()
          WHERE assignment.line_id IS NULL RETURNING phone
      )
      UPDATE campaign_line_rotation SET next_position=next_position+(SELECT COUNT(*) FROM allocated)
      WHERE owner_key=$2`, [campaignId, owner, lineIds])
  })
}

export async function getCampaignAssignedLine(campaignId: string, phone: string): Promise<string | null> {
  const [row] = await query<{ line_id: string | null }>(`
    SELECT a.line_id FROM campaign_line_assignments a JOIN campaigns c
      ON a.owner_key=COALESCE(c.owned_by,'${ROUTING_SYSTEM_OWNER}'::uuid)
    WHERE c.id=$1 AND a.phone=regexp_replace($2, '[^0-9]', '', 'g')`, [campaignId, phone])
  return row?.line_id ?? null
}

/** Used inside atomic claims: no matching assignment means no send. */
export function campaignRoutingCondition(recipientAlias: string, linesParameter: string): string {
  return `EXISTS (SELECT 1 FROM campaign_line_assignments a JOIN campaigns routing_campaign
    ON a.owner_key=COALESCE(routing_campaign.owned_by,'${ROUTING_SYSTEM_OWNER}'::uuid)
    WHERE routing_campaign.id=${recipientAlias}.campaign_id
      AND a.phone=regexp_replace(${recipientAlias}.phone_number, '[^0-9]', '', 'g')
      AND a.line_id=ANY(${linesParameter}::uuid[]))`
}
