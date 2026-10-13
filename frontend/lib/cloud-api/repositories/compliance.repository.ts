// Repository para cloud_opt_outs, cloud_consent_log y cloud_stop_keywords.

import { query } from '@/lib/db'
import { isGloballyOptedOut, recordGlobalOptOut } from '@/lib/global-opt-out'

export const complianceRepository = {

  async isOptedOut(phone: string, phoneNumberId: string): Promise<boolean> {
    return isGloballyOptedOut(phone)
  },

  async recordOptOut(opts: {
    phone:         string
    phoneNumberId: string
    reason:        'stop_keyword' | 'manual' | 'policy_violation' | 'user_request'
    wamid?:        string
    agentUserId?:  string
    metadata?:     Record<string, unknown>
    confirmation?: boolean
  }): Promise<void> {
    await recordGlobalOptOut({phone:opts.phone,sourceId:opts.phoneNumberId,provider:'cloud',
      messageId:opts.wamid,agentUserId:opts.agentUserId,metadata:opts.metadata,confirmation:opts.confirmation,
      text:typeof opts.metadata?.keyword === 'string' ? opts.metadata.keyword : undefined})
  },

  async recordOptIn(opts: {
    phone:         string
    phoneNumberId: string
    channel:       'whatsapp' | 'web' | 'sms' | 'manual'
    source?:       string
    agentUserId?:  string
  }): Promise<void> {
    // Reactivation belongs exclusively to the admin blacklist action with evidence.
    throw new Error('Reactivá el contacto desde Blacklist y registrá su nuevo consentimiento.')
  },

  async matchesStopKeyword(text: string): Promise<boolean> {
    const normalized = text.trim().replace(/\s+/g, ' ').toUpperCase()
    if (normalized === 'BAJA') return true
    if (!normalized) return false
    const rows = await query<{ keyword: string }>(
      `SELECT keyword FROM cloud_stop_keywords WHERE upper(keyword) = $1`,
      [normalized],
    )
    return rows.length > 0
  },
}
