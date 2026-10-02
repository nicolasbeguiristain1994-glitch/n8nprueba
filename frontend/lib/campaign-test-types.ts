export type CampaignTestRecipient = { id: string; first_name: string; phone_number: string }
export type CampaignTestLine = { id: string; display_name: string; phone_number_id: string }
export type CampaignTestAttempt = {
  id: string; campaign_id: string; recipient_id: string; line_id: string
  first_name: string; phone_number: string; line_name: string
  status: 'sending' | 'sent' | 'failed' | 'uncertain'
  provider_message_id: string | null; error: string | null; created_at: string
}
export type CampaignTestSnapshot = {
  recipients: CampaignTestRecipient[]; lines: CampaignTestLine[]; attempts: CampaignTestAttempt[]
}
