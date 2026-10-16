export const CAMPAIGN_SELECTION_LIMIT = 100_000
export interface CampaignSelectionSummary {
  selected: number
  eligible: number
  excluded: number
  blacklisted: number
  inactive: number
  opted_out: number
  duplicates: number
}
