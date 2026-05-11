// Repository para cloud_opt_outs, cloud_consent_log y cloud_stop_keywords.

import { query } from '@/lib/db'

export const complianceRepository = {

  async isOptedOut(phone: string, phoneNumberId: string): Promise<boolean> {
    const rows = await query<{ opted_out: boolean }>(
      `SELECT opted_out FROM cloud_opt_outs WHERE contact_phone = $1 AND phone_number_id = $2`,
      [phone, phoneNumberId],
    )
    return rows[0]?.opted_out ?? false
  },

  async recordOptOut(opts: {
    phone:         string
    phoneNumberId: string
    reason:        'stop_keyword' | 'manual' | 'policy_violation' | 'user_request'
    wamid?:        string
    agentUserId?:  string
    metadata?:     Record<string, unknown>
  }): Promise<void> {
    await query(
      `INSERT INTO cloud_opt_outs (contact_phone, phone_number_id, opted_out, opted_out_at, reason)
       VALUES ($1, $2, true, NOW(), $3)
       ON CONFLICT (contact_phone, phone_number_id)
       DO UPDATE SET opted_out = true, opted_out_at = NOW(), reason = $3`,
      [opts.phone, opts.phoneNumberId, opts.reason],
    )
    await query(
      `INSERT INTO cloud_consent_log
         (contact_phone, phone_number_id, event, source, message_wamid, agent_user_id, metadata)
       VALUES ($1, $2, 'opt_out', $3, $4, $5, $6)`,
      [
        opts.phone, opts.phoneNumberId,
        opts.wamid ? 'inbound_message' : 'agent_action',
        opts.wamid ?? null, opts.agentUserId ?? null,
        opts.metadata ? JSON.stringify(opts.metadata) : null,
      ],
    )
  },

  async recordOptIn(opts: {
    phone:         string
    phoneNumberId: string
    channel:       'whatsapp' | 'web' | 'sms' | 'manual'
    source?:       string
    agentUserId?:  string
  }): Promise<void> {
    await query(
      `INSERT INTO cloud_opt_outs (contact_phone, phone_number_id, opted_out, opted_out_at, reason)
       VALUES ($1, $2, false, NULL, NULL)
       ON CONFLICT (contact_phone, phone_number_id)
       DO UPDATE SET opted_out = false, opted_out_at = NULL, reason = NULL`,
      [opts.phone, opts.phoneNumberId],
    )
    await query(
      `INSERT INTO cloud_consent_log
         (contact_phone, phone_number_id, event, channel, source, agent_user_id)
       VALUES ($1, $2, 'opt_in', $3, $4, $5)`,
      [opts.phone, opts.phoneNumberId, opts.channel, opts.source ?? null, opts.agentUserId ?? null],
    )
  },

  async matchesStopKeyword(text: string): Promise<boolean> {
    const normalized = text.trim().toUpperCase()
    const rows = await query<{ keyword: string }>(
      `SELECT keyword FROM cloud_stop_keywords WHERE upper(keyword) = $1`,
      [normalized],
    )
    return rows.length > 0
  },
}
