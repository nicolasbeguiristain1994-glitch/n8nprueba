export type MissingContact = {
  username: string
  platform: string
  agent: string
  source_agent: string
  last_movement: string | null
  first_seen_at: string | null
}

export type MissingContactImportRow = {
  row: number
  username: string
  platform: string
  agent: string
  name: string
  phone: string
}

export type MissingContactImportResult = {
  total: number
  ready: number
  inserted: number
  linked: number
  unchanged: number
  blank: number
  errors: Array<{ row: number; username: string; error: string }>
  dryRun: boolean
}
