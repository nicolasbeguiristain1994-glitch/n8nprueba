import type { PoolClient } from 'pg'
import { query, withTransaction } from '@/lib/db'
import { normalizePhone } from '@/lib/validate'
import { OptOutError } from '@/lib/cloud-api/errors'

export const OPT_OUT_REASON = 'Baja solicitada por el contacto'
export const OPT_OUT_CANCELLED = 'global-opt-out'

function phoneKey(phone: string): string {
  const key = normalizePhone(phone)
  if (!key || !/^\d+$/.test(key)) throw new Error('Teléfono inválido')
  return key
}

async function lockPhone(db: PoolClient, phone: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`global-opt-out:${phone}`])
}

// Include pre-existing per-line opt-outs until an administrator explicitly
// reinstates them. Imports and contact/agent changes never modify this state.
const blockedSql = `SELECT 1 FROM blacklist WHERE phone_number_normalized=$1 AND removed_at IS NULL
  UNION ALL SELECT 1 FROM cloud_opt_outs WHERE contact_phone IN ($1,'+'||$1) AND opted_out=true LIMIT 1`

export async function isGloballyOptedOut(phone: string): Promise<boolean> {
  return (await query(blockedSql, [phoneKey(phone)])).length > 0
}

// The same per-phone transaction lock serializes opt-out/reactivation with
// provider submission. A request already submitted cannot be recalled.
export async function withGlobalSendGuard<T>(phone: string, send: (db: PoolClient) => Promise<T>): Promise<T> {
  const key = phoneKey(phone)
  return withTransaction(async db => {
    await lockPhone(db, key)
    if ((await db.query(blockedSql, [key])).rows.length) throw new OptOutError(key)
    return send(db)
  })
}

export async function recordGlobalOptOut(opts: {
  phone: string; sourceId: string; messageId?: string; text?: string;
  provider: 'cloud' | 'evolution'; metadata?: Record<string, unknown>; agentUserId?: string
}): Promise<void> {
  const key = phoneKey(opts.phone)
  const sourceId = opts.provider === 'cloud' ? opts.sourceId : `evolution:${opts.sourceId}`
  await withTransaction(async db => {
    await lockPhone(db, key)
    // Keep the receipt after reactivation: an old webhook retry must not undo it.
    if (opts.messageId && (await db.query(`SELECT 1 FROM cloud_consent_log
      WHERE contact_phone=$1 AND phone_number_id=$2 AND message_wamid=$3 AND event='opt_out' LIMIT 1`,
    ['+'+key, sourceId, opts.messageId])).rows.length) return

    const { rows: campaigns } = await db.query<{ campaign_id: string }>(`SELECT campaign_id
      FROM whatsapp_messages WHERE regexp_replace(phone_number,'[^0-9]','','g')=$1
      AND direction='outbound' AND status IN ('sent','delivered','read') AND campaign_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`, [key])
    const campaignId = campaigns[0]?.campaign_id ?? null
    const inserted = await db.query<{ id: string }>(`INSERT INTO blacklist
      (phone_number_raw,phone_number_normalized,reason,source,original_message,campaign_id)
      VALUES($1,$2,$3,'automatic',$4,$5)
      ON CONFLICT(phone_number_normalized) WHERE removed_at IS NULL DO UPDATE
      SET reason=EXCLUDED.reason,source='automatic',original_message=EXCLUDED.original_message,
          campaign_id=COALESCE(EXCLUDED.campaign_id,blacklist.campaign_id)
      RETURNING id`, [opts.phone,key,OPT_OUT_REASON,opts.text?.slice(0,500) ?? null,campaignId])
    await db.query(`INSERT INTO cloud_opt_outs(contact_phone,phone_number_id,opted_out,opted_out_at,reason)
      VALUES($1,$2,true,NOW(),'stop_keyword') ON CONFLICT(contact_phone,phone_number_id)
      DO UPDATE SET opted_out=true,opted_out_at=NOW(),reason='stop_keyword'`, ['+'+key,sourceId])
    await db.query(`INSERT INTO cloud_consent_log
      (contact_phone,phone_number_id,event,source,message_wamid,agent_user_id,metadata)
      VALUES($1,$2,'opt_out',$3,$4,$5,$6::jsonb)`, ['+'+key,sourceId,
      opts.messageId ? 'inbound_message' : 'agent_action',opts.messageId ?? null,opts.agentUserId ?? null,
      JSON.stringify({...opts.metadata,provider:opts.provider,scope:'global',blacklist_id:inserted.rows[0].id,campaign_id:campaignId})])

    // Pending work is terminal even if consent is restored before a worker wakes.
    await db.query(`UPDATE campaign_recipients SET status='skipped',locked_at=NULL,
      error_detail=$2,updated_at=NOW() WHERE regexp_replace(phone_number,'[^0-9]','','g')=$1
      AND status='pending'`, [key,OPT_OUT_REASON])
    await db.query(`UPDATE automation_message_jobs SET status='skipped',finished_at=NOW(),details=$2
      WHERE phone=$1 AND status='queued'`, [key,OPT_OUT_REASON])
    await db.query(`UPDATE cloud_messages m SET status='failed',failed_at=NOW(),error_code=NULL,
      error_title=$2,error_details=$3 FROM cloud_conversations c
      WHERE m.conversation_id=c.id AND c.contact_phone IN ($1,'+'||$1)
      AND m.direction='outbound' AND m.status='queued' AND m.wamid IS NULL`,
    [key,OPT_OUT_CANCELLED,OPT_OUT_REASON])
  })
}

export async function reinstateGlobalContact(id: string, userId: string, consent: string): Promise<boolean> {
  if (consent.trim().length < 10) throw new Error('Registrá el nuevo consentimiento del contacto (al menos 10 caracteres).')
  return withTransaction(async db => {
    const {rows} = await db.query<{phone_number_normalized:string}>(
      'SELECT phone_number_normalized FROM blacklist WHERE id=$1 AND removed_at IS NULL', [id])
    if (!rows.length) return false
    const key = rows[0].phone_number_normalized
    await lockPhone(db,key)
    const removed = await db.query(`UPDATE blacklist SET removed_at=NOW(),removed_by=$2
      WHERE id=$1 AND removed_at IS NULL RETURNING id`, [id,userId])
    if (!removed.rows.length) return false
    await db.query(`UPDATE cloud_opt_outs SET opted_out=false,opted_out_at=NULL,reason=NULL
      WHERE contact_phone IN ($1,'+'||$1)`, [key])
    await db.query(`INSERT INTO cloud_consent_log(contact_phone,phone_number_id,event,channel,source,agent_user_id,metadata)
      VALUES($1,'global','reinstated','manual','agent_action',$2,$3::jsonb)`,
    ['+'+key,userId,JSON.stringify({blacklist_id:id,scope:'global',consent:consent.trim()})])
    return true
  })
}
