// ── Tipos de dominio para el módulo "Base de Difusión" ────────────────────────

export interface Prospect {
  id:              string
  phone_number:    string
  first_name:      string | null
  last_name:       string | null
  email:           string | null
  tags:            string[]
  source:          string
  import_batch_id: string | null
  status:          'active' | 'unsubscribed'
  opt_in:          boolean
  consent_source:  string | null
  notes:           string | null
  created_at:      string
  updated_at:      string
}

export interface ProspectImportBatch {
  id:                       string
  filename:                 string | null
  total_rows:               number
  imported:                 number
  skipped_duplicates:       number
  skipped_invalid:          number
  warned_existing_contacts: number
  notes:                    string | null
  created_at:               string
}

export interface ProspectImportResult {
  batch_id:                 string | null
  imported:                 number
  skipped_duplicates:       number
  skipped_invalid:          number
  warned_existing_contacts: number
  total_rows:               number
  warnings:                 string[]   // teléfonos que ya existen en contacts
}

export interface ProspectListResponse {
  prospects: Prospect[]
  total:     number
  page:      number
  limit:     number
}
