// Repository para la tabla `templates` (dominio externo al cloud-api,
// pero cloud-api necesita actualizar el estado cuando Meta aprueba/rechaza).

import { query } from '@/lib/db'

export const templateRepository = {

  async updateTemplateStatus(
    metaTemplateId: string,
    status:         string,
    rejectionReason: string | null = null,
  ): Promise<void> {
    await query(
      `UPDATE templates
       SET whatsapp_status  = $1,
           rejection_reason = $2,
           updated_at       = NOW()
       WHERE whatsapp_template_id = $3`,
      [status, rejectionReason, metaTemplateId],
    )
  },
}
