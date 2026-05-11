// Responsabilidad única: gestión del ciclo de vida del número (OTP, registro, info).

import { MetaHttpGateway } from './meta-http.gateway'

export interface PhoneNumberInfo {
  id:                       string
  verified_name:             string
  display_phone_number:      string
  quality_rating:            string
  code_verification_status:  string
  name_status:               string
  platform_type:             string
  throughput:                { level: string }
}

const PHONE_FIELDS = 'id,verified_name,display_phone_number,quality_rating,code_verification_status,name_status,platform_type,throughput'

export class PhoneNumberService {
  private readonly gw: MetaHttpGateway

  constructor(accessToken: string) {
    this.gw = new MetaHttpGateway(accessToken, {
      circuitBreakerKey: 'meta:phone-numbers',
      timeoutMs:         15_000,
    })
  }

  async getInfo(phoneNumberId: string): Promise<PhoneNumberInfo> {
    return this.gw.get<PhoneNumberInfo>(`/${phoneNumberId}?fields=${PHONE_FIELDS}`)
  }

  async list(wabaId: string): Promise<Array<{ id: string; display_phone_number: string; verified_name: string }>> {
    const data = await this.gw.get<{ data: Array<{ id: string; display_phone_number: string; verified_name: string }> }>(
      `/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`,
    )
    return data.data
  }

  async requestOTP(phoneNumberId: string, method: 'SMS' | 'VOICE' = 'SMS'): Promise<void> {
    await this.gw.post(`/${phoneNumberId}/request_code`, {
      code_method: method,
      language:    'es',
    })
  }

  async verifyOTP(phoneNumberId: string, code: string): Promise<void> {
    await this.gw.post(`/${phoneNumberId}/verify_code`, { code })
  }

  async register(phoneNumberId: string, pin = '000000'): Promise<void> {
    await this.gw.post(`/${phoneNumberId}/register`, {
      messaging_product: 'whatsapp',
      pin,
    })
  }
}
