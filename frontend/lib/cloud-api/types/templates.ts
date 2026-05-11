// Tipos de plantillas de WhatsApp

export type TemplateStatus   = 'APPROVED' | 'PENDING' | 'REJECTED' | 'DISABLED' | 'IN_APPEAL' | 'PAUSED'
export type TemplateCategory = 'UTILITY' | 'MARKETING' | 'AUTHENTICATION'

export interface CreateTemplateRequest {
  wabaId:     string
  name:       string
  category:   TemplateCategory
  language:   string
  components: unknown[]
}

export interface MetaTemplate {
  id:               string
  name:             string
  status:           TemplateStatus
  category:         TemplateCategory
  language:         string
  components:       unknown[]
  rejected_reason?: string
  quality_score?:   { score: string; date: number; reasons?: string[] }
}

export interface MetaError {
  code:        number
  title:       string
  message?:    string
  error_data?: { details?: string; messaging_product?: string }
  href?:       string
}

// Error que retorna la REST API de Meta (diferente del error en webhooks)
export interface MetaApiError {
  error: {
    message:         string
    type:            string
    code:            number
    error_subcode?:  number
    fbtrace_id?:     string
    error_data?:     Record<string, unknown>
  }
}
