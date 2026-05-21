// ── Tipos de dominio para el módulo "Base de Difusión" ────────────────────────

export type ProspectStage = 'nuevo' | 'contactado' | 'interesado' | 'descartado'

export const PROSPECT_STAGE_LABELS: Record<ProspectStage, string> = {
  nuevo:      'Nuevo',
  contactado: 'Contactado',
  interesado: 'Interesado',
  descartado: 'Descartado',
}

export interface Prospect {
  id:              string
  phone_number:    string
  first_name:      string | null
  last_name:       string | null
  email:           string | null
  tags:            string[]
  source:          string
  import_batch_id: string | null
  status:                  'active' | 'unsubscribed' | 'converted'
  stage:                   ProspectStage
  opt_in:                  boolean
  consent_source:          string | null
  notes:                   string | null
  converted_to_contact_id: string | null
  created_at:              string
  updated_at:              string
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

// ── Listas de Difusión ─────────────────────────────────────────────────────────

export interface ProspectList {
  id:             string
  name:           string
  description:    string | null
  member_count:   number
  last_used_at:   string | null
  campaign_count: number
  created_by:     string | null
  owned_by:       string | null
  owner_name:     string | null   // JOIN a users.name, solo en listado
  created_at:     string
  updated_at:     string
}

export interface ProspectListMember {
  id:               string
  prospect_list_id: string
  prospect_id:      string
  added_at:         string
  added_by:         string | null
  // joined from prospects
  phone_number:     string
  first_name:       string | null
  last_name:        string | null
  email:            string | null
  status:           'active' | 'unsubscribed' | 'converted'
  stage:            ProspectStage
  opt_in:           boolean
}
