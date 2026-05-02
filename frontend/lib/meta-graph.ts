// Meta Graph API helper
// Requiere en .env: META_ACCESS_TOKEN, META_WABA_ID

const META_VERSION = 'v19.0'
const BASE = `https://graph.facebook.com/${META_VERSION}`

function getCredentials() {
  const token = process.env.META_ACCESS_TOKEN
  const wabaId = process.env.META_WABA_ID
  if (!token || !wabaId) {
    throw new Error('META_ACCESS_TOKEN y META_WABA_ID son requeridos en las variables de entorno')
  }
  return { token, wabaId }
}

export type MetaTemplateStatus = 'APPROVED' | 'PENDING' | 'REJECTED' | 'DISABLED' | 'IN_APPEAL' | 'PAUSED'

export interface MetaSubmitPayload {
  name: string
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION'
  language: string
  components: unknown[]
}

export async function submitTemplateToMeta(payload: MetaSubmitPayload): Promise<{ id: string; status: string }> {
  const { token, wabaId } = getCredentials()
  const res = await fetch(`${BASE}/${wabaId}/message_templates`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  })
  const data = await res.json() as Record<string, unknown>
  if (!res.ok) {
    const errMsg = (data?.error as Record<string, unknown>)?.message || `Meta error ${res.status}`
    throw new Error(String(errMsg))
  }
  return { id: String(data.id), status: String(data.status) }
}

export async function getTemplateStatusFromMeta(whatsappTemplateId: string): Promise<{ status: MetaTemplateStatus; rejection_reason?: string }> {
  const { token } = getCredentials()
  const res = await fetch(
    `${BASE}/${whatsappTemplateId}?fields=status,rejected_reason`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data = await res.json() as Record<string, unknown>
  if (!res.ok) {
    const errMsg = (data?.error as Record<string, unknown>)?.message || `Meta error ${res.status}`
    throw new Error(String(errMsg))
  }
  return {
    status: data.status as MetaTemplateStatus,
    rejection_reason: data.rejected_reason as string | undefined,
  }
}

// Mapea estado Meta → estado interno
export function mapMetaStatus(metaStatus: MetaTemplateStatus): string {
  const map: Record<MetaTemplateStatus, string> = {
    APPROVED:  'APROBADA',
    PENDING:   'EN_REVISION',
    REJECTED:  'RECHAZADA',
    DISABLED:  'DESHABILITADA',
    IN_APPEAL: 'EN_REVISION',
    PAUSED:    'DESHABILITADA',
  }
  return map[metaStatus] ?? 'EN_REVISION'
}
