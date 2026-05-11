import { randomUUID } from 'crypto'

// Correlation ID simple: se genera una vez por evento raíz (webhook POST, use case entry)
// y se pasa como parámetro a todos los handlers/servicios involucrados.
// Se incluye en todos los logs estructurados para trazabilidad completa.
//
// Decisión: parámetro explícito vs AsyncLocalStorage.
// Elegimos parámetro porque: (a) compatible con cualquier runtime (Edge, Node),
// (b) visible en firmas (sin magia), (c) testeable sin setup especial.

export function createCorrelationId(): string {
  return randomUUID()
}

export function structuredLog(
  level:         'info' | 'warn' | 'error',
  correlationId: string,
  event:         string,
  data:          Record<string, unknown> = {},
): void {
  console[level](JSON.stringify({ level, correlationId, event, ...data, ts: new Date().toISOString() }))
}
