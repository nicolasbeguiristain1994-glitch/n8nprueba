// Facade de compatibilidad: delega al compliance repository.
// Mantiene la API pública para código que ya importa de este módulo.

import { complianceRepository } from './repositories/compliance.repository'
import { OptOutError }          from './errors'

export async function assertNotOptedOut(phone: string, phoneNumberId: string): Promise<void> {
  if (await complianceRepository.isOptedOut(phone, phoneNumberId)) {
    throw new OptOutError(phone)
  }
}

export async function isOptedOut(phone: string, phoneNumberId: string): Promise<boolean> {
  return complianceRepository.isOptedOut(phone, phoneNumberId)
}

export async function recordOptOut(opts: Parameters<typeof complianceRepository.recordOptOut>[0]): Promise<void> {
  return complianceRepository.recordOptOut(opts)
}

export async function recordOptIn(opts: Parameters<typeof complianceRepository.recordOptIn>[0]): Promise<void> {
  return complianceRepository.recordOptIn(opts)
}

export async function checkAndHandleStopKeyword(
  messageText:   string,
  phone:         string,
  phoneNumberId: string,
  wamid:         string,
): Promise<boolean> {
  const isStop = await complianceRepository.matchesStopKeyword(messageText)
  if (!isStop) return false

  await complianceRepository.recordOptOut({
    phone, phoneNumberId, reason: 'stop_keyword', wamid,
    metadata: { keyword: messageText.trim().toUpperCase() },
  })
  return true
}

export async function logSendAttempt(_opts: {
  phoneNumberId:  string
  to:             string
  messageId:      string
  messageType:    string
  templateName?:  string
  campaignId?:    string
  sentByUserId?:  string
  success:        boolean
  errorCode?:     number
  errorMessage?:  string
}): Promise<void> {
  // El log estructurado principal ocurre en el use case via cloudMetrics.
  // Este método queda por backward compat pero no hace IO adicional.
}
