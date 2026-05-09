import { createHmac, timingSafeEqual } from 'crypto'

// Meta firma cada webhook con HMAC-SHA256 usando el App Secret.
// El header es: x-hub-signature-256: sha256=<hex>
// CRÍTICO: siempre usar comparación en tiempo constante para evitar timing attacks.

const SIGNATURE_HEADER = 'x-hub-signature-256'
const PREFIX           = 'sha256='

export interface VerificationResult {
  valid:  boolean
  reason?: string
}

export function verifyWebhookSignature(
  rawBody:   Buffer | string,
  headers:   Record<string, string | string[] | undefined>,
  appSecret: string,
): VerificationResult {
  const signatureHeader = headers[SIGNATURE_HEADER]
  if (!signatureHeader) {
    return { valid: false, reason: `Header ${SIGNATURE_HEADER} ausente` }
  }

  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader
  if (!signature.startsWith(PREFIX)) {
    return { valid: false, reason: 'Formato de firma inválido (debe empezar con sha256=)' }
  }

  const receivedHex = signature.slice(PREFIX.length)
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody
  const expectedHex = createHmac('sha256', appSecret).update(body).digest('hex')

  try {
    const received = Buffer.from(receivedHex, 'hex')
    const expected = Buffer.from(expectedHex, 'hex')

    if (received.length !== expected.length) {
      return { valid: false, reason: 'Longitud de firma inválida' }
    }

    const valid = timingSafeEqual(received, expected)
    return valid ? { valid: true } : { valid: false, reason: 'Firma HMAC-SHA256 no coincide' }
  } catch {
    return { valid: false, reason: 'Error al procesar la firma' }
  }
}

// Verificación del challenge de Meta para validar el endpoint de webhooks
export function verifyWebhookChallenge(params: {
  mode:        string | null
  token:       string | null
  challenge:   string | null
  verifyToken: string
}): string | null {
  if (
    params.mode      === 'subscribe' &&
    params.token     === params.verifyToken &&
    params.challenge !== null
  ) {
    return params.challenge
  }
  return null
}
