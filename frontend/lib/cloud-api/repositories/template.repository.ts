// Repository para la tabla `templates` (dominio externo al cloud-api,
// pero cloud-api necesita actualizar el estado cuando Meta aprueba/rechaza).

import { query } from '@/lib/db'

export const templateRepository = {

  async updateTemplateStatus(
    metaTemplateId: string,
    status:         string,
    rejectionReason: string | null,
    scope: { wabaId: string; includeLegacy: boolean },
  ): Promise<void> {
    await query(
      `UPDATE whatsapp_templates
       SET status  = $1,
           rejection_reason = $2,
           updated_at       = NOW()
       WHERE whatsapp_template_id = $3
         AND (waba_id = $4 OR ($5 AND waba_id IS NULL))`,
      [status, rejectionReason, metaTemplateId, scope.wabaId, scope.includeLegacy],
    )
  },
}
