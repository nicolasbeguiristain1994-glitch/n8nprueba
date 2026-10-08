export type CampaignTestRecipient = { id: string; first_name: string; phone_number: string }
export type CampaignTestLine = { id: string; display_name: string; phone_number_id: string }
export type CampaignTestAttempt = {
  id: string; campaign_id: string; recipient_id: string; line_id: string
  first_name: string; phone_number: string; line_name: string
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'uncertain'
  provider_message_id: string | null; error: string | null; created_at: string
  delivery_error_code?: number | null; delivery_updated_at?: string | null
}
export type CampaignTestSnapshot = {
  recipients: CampaignTestRecipient[]; lines: CampaignTestLine[]; attempts: CampaignTestAttempt[]
}
