// Repository para cloud_numbers.
// Todo el SQL de esta entidad vive aquí. Cero SQL en capas superiores.

import { query } from '@/lib/db'
import type { CloudNumber, CloudNumberStatus, QualityRating } from '../types/domain'

type CloudNumberRow = {
  id:                  string
  waba_id:             string
  phone_number_id:     string
  display_phone:       string
  verified_name:       string | null
  token_expires_at:    Date | null
  status:              CloudNumberStatus
  coexistence_enabled: boolean
  contacts_synced:     boolean
  history_synced:      boolean
  history_sync_days:   number
  quality_rating:      QualityRating
  messaging_limit_tier: string
  whatsapp_line_id:    string | null
  chatwoot_inbox_id:   string | null
  chatwoot_inbox_name: string | null
  chatwoot_created_at: Date | null
  onboarded_at:        Date | null
  created_at:          Date
  updated_at:          Date
}

function mapRow(r: CloudNumberRow): CloudNumber {
  return {
    id:                 r.id,
    wabaId:             r.waba_id,
    phoneNumberId:      r.phone_number_id,
    displayPhone:       r.display_phone,
    verifiedName:       r.verified_name,
    tokenExpiresAt:     r.token_expires_at,
    status:             r.status,
    coexistenceEnabled: r.coexistence_enabled,
    contactsSynced:     r.contacts_synced,
    historySynced:      r.history_synced,
    historySyncDays:    r.history_sync_days,
    qualityRating:      r.quality_rating,
    messagingLimitTier: r.messaging_limit_tier as CloudNumber['messagingLimitTier'],
    whatsappLineId:     r.whatsapp_line_id,
    chatwootInboxId:    r.chatwoot_inbox_id,
    chatwootInboxName:  r.chatwoot_inbox_name,
    chatwootCreatedAt:  r.chatwoot_created_at,
    onboardedAt:        r.onboarded_at,
    createdAt:          r.created_at,
    updatedAt:          r.updated_at,
  }
}

const SELECT_COLS = `
  id, waba_id, phone_number_id, display_phone, verified_name,
  token_expires_at, status, coexistence_enabled, contacts_synced,
  history_synced, history_sync_days, quality_rating, messaging_limit_tier,
  whatsapp_line_id, chatwoot_inbox_id, chatwoot_inbox_name, chatwoot_created_at,
  onboarded_at, created_at, updated_at`

export const cloudNumberRepository = {

  async findById(id: string): Promise<CloudNumber | null> {
    const rows = await query<CloudNumberRow>(`SELECT ${SELECT_COLS} FROM cloud_numbers WHERE id = $1`, [id])
    return rows[0] ? mapRow(rows[0]) : null
  },

  async findByPhoneNumberId(phoneNumberId: string): Promise<CloudNumber | null> {
    const rows = await query<CloudNumberRow>(
      `SELECT ${SELECT_COLS} FROM cloud_numbers WHERE phone_number_id = $1`,
      [phoneNumberId],
    )
    return rows[0] ? mapRow(rows[0]) : null
  },

  async findAllActive(): Promise<CloudNumber[]> {
    const rows = await query<CloudNumberRow>(
      `SELECT ${SELECT_COLS} FROM cloud_numbers WHERE status = 'active' ORDER BY created_at`,
    )
    return rows.map(mapRow)
  },

  async findAll(): Promise<CloudNumber[]> {
    const rows = await query<CloudNumberRow>(
      `SELECT ${SELECT_COLS} FROM cloud_numbers ORDER BY created_at DESC`,
    )
    return rows.map(mapRow)
  },

  async insert(data: {
    wabaId:               string
    phoneNumberId:        string
    displayPhone:         string
    verifiedName:         string | null
    plainToken:           string
    tokenExpiresAt:       Date | null
    whatsappLineId?:      string
    onboardedBy:          string
    encryptionKey:        string
    coexistenceEnabled?:  boolean
  }): Promise<string> {
    const rows = await query<{ id: string }>(
      `INSERT INTO cloud_numbers
         (waba_id, phone_number_id, display_phone, verified_name,
          access_token_enc, access_token, token_expires_at,
          status, coexistence_enabled, whatsapp_line_id, onboarded_by, onboarded_at)
       VALUES ($1, $2, $3, $4, pgp_sym_encrypt($5, $6), '', $7, 'pending', $8, $9, $10, NOW())
       RETURNING id`,
      [
        data.wabaId, data.phoneNumberId, data.displayPhone, data.verifiedName,
        data.plainToken, data.encryptionKey, data.tokenExpiresAt,
        data.coexistenceEnabled ?? false,
        data.whatsappLineId ?? null, data.onboardedBy,
      ],
    )
    return rows[0].id
  },

  async updateToken(phoneNumberId: string, plainToken: string, expiresAt: Date | null, encKey: string): Promise<void> {
    await query(
      `UPDATE cloud_numbers
       SET access_token_enc = pgp_sym_encrypt($1, $2), access_token = '', token_expires_at = $3, updated_at = NOW()
       WHERE phone_number_id = $4`,
      [plainToken, encKey, expiresAt, phoneNumberId],
    )
  },

  async updateStatus(phoneNumberId: string, status: CloudNumberStatus): Promise<void> {
    await query(
      `UPDATE cloud_numbers SET status = $1, updated_at = NOW() WHERE phone_number_id = $2`,
      [status, phoneNumberId],
    )
  },

  async markSyncComplete(phoneNumberId: string, type: 'contacts' | 'history'): Promise<void> {
    const col = type === 'contacts' ? 'contacts_synced' : 'history_synced'
    await query(
      `UPDATE cloud_numbers SET ${col} = true, updated_at = NOW() WHERE phone_number_id = $1`,
      [phoneNumberId],
    )
  },

  async updateQuality(phoneNumberId: string, qualityRating: QualityRating, verifiedName?: string): Promise<void> {
    await query(
      `UPDATE cloud_numbers
       SET quality_rating = $1, ${verifiedName ? 'verified_name = $3,' : ''} updated_at = NOW()
       WHERE phone_number_id = $2`,
      verifiedName ? [qualityRating, phoneNumberId, verifiedName] : [qualityRating, phoneNumberId],
    )
  },

  async recordSyncError(phoneNumberId: string, syncType: string, error: string): Promise<void> {
    await query(
      `INSERT INTO cloud_sync_state (phone_number_id, sync_error, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (phone_number_id) DO UPDATE SET sync_error = $2, updated_at = NOW()`,
      [phoneNumberId, `[${syncType}] ${error}`],
    ).catch(() => {})
  },

  async linkToLine(cloudNumberId: string, lineId: string): Promise<void> {
    await query(
      `UPDATE cloud_numbers SET whatsapp_line_id = $1, updated_at = NOW() WHERE id = $2`,
      [lineId, cloudNumberId],
    )
  },

  async setChatwootInbox(phoneNumberId: string, inboxId: string, inboxName: string): Promise<void> {
    await query(
      `UPDATE cloud_numbers
       SET chatwoot_inbox_id = $1, chatwoot_inbox_name = $2, chatwoot_created_at = NOW(), updated_at = NOW()
       WHERE phone_number_id = $3`,
      [inboxId, inboxName, phoneNumberId],
    )
  },

  async upsertForReOnboarding(data: {
    id:                   string
    wabaId:               string
    displayPhone:         string
    verifiedName:         string | null
    plainToken:           string
    tokenExpiresAt:       Date | null
    encryptionKey:        string
    coexistenceEnabled?:  boolean
  }): Promise<void> {
    await query(
      `UPDATE cloud_numbers
       SET waba_id = $1, access_token_enc = pgp_sym_encrypt($2, $3), access_token = '',
           token_expires_at = $4, verified_name = $5, display_phone = $6,
           coexistence_enabled = $7,
           status = 'pending', contacts_synced = false, history_synced = false, updated_at = NOW()
       WHERE id = $8`,
      [
        data.wabaId, data.plainToken, data.encryptionKey,
        data.tokenExpiresAt, data.verifiedName, data.displayPhone,
        data.coexistenceEnabled ?? false, data.id,
      ],
    )
  },
}
