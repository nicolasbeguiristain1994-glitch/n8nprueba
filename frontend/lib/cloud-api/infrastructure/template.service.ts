// Responsabilidad única: CRUD de plantillas en Meta.

import { MetaHttpGateway } from './meta-http.gateway'
import type { MetaTemplate, CreateTemplateRequest } from '../types/templates'

const TEMPLATE_FIELDS = 'id,name,status,category,language,components,rejected_reason,quality_score'

export class TemplateService {
  private readonly gw: MetaHttpGateway

  constructor(accessToken: string) {
    this.gw = new MetaHttpGateway(accessToken, {
      circuitBreakerKey: 'meta:templates',
      timeoutMs:         20_000, // Meta puede tardar más en operaciones de plantillas
    })
  }

  async create(req: CreateTemplateRequest): Promise<{ id: string; status: string }> {
    return this.gw.post<{ id: string; status: string }>(`/${req.wabaId}/message_templates`, {
      name:       req.name,
      category:   req.category,
      language:   req.language,
      components: req.components,
    })
  }

  async list(wabaId: string, limit = 100): Promise<MetaTemplate[]> {
    const data = await this.gw.get<{ data: MetaTemplate[] }>(
      `/${wabaId}/message_templates?fields=${TEMPLATE_FIELDS}&limit=${limit}`,
    )
    return data.data
  }

  async get(templateId: string): Promise<MetaTemplate> {
    return this.gw.get<MetaTemplate>(`/${templateId}?fields=${TEMPLATE_FIELDS}`)
  }

  async delete(wabaId: string, templateName: string): Promise<void> {
    await this.gw.delete(`/${wabaId}/message_templates?name=${encodeURIComponent(templateName)}`)
  }
}
