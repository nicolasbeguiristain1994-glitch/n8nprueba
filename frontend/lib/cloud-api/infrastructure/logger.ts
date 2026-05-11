// Logger centralizado para el módulo Cloud API.
// Produce logs estructurados (JSON) con contexto fijo (correlationId, phoneNumberId, operation)
// y datos adicionales opcionales por llamada.
//
// Uso:
//   const log = createLogger({ correlationId, phoneNumberId, operation: 'send_message' })
//   log.logInfo('message sent', { wamid })
//   log.logError('send failed', error, { attempt: 3 })

export interface LogContext {
  correlationId:  string
  phoneNumberId?: string
  operation?:     string
}

export interface Logger {
  logInfo:  (message: string, extra?: Record<string, unknown>) => void
  logWarn:  (message: string, extra?: Record<string, unknown>) => void
  logError: (message: string, error?: unknown, extra?: Record<string, unknown>) => void
}

function toErrorShape(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack }
  }
  return { raw: String(err) }
}

function emit(
  level:   'info' | 'warn' | 'error',
  message: string,
  ctx:     LogContext,
  extra?:  Record<string, unknown>,
  err?:    unknown,
): void {
  const entry: Record<string, unknown> = {
    level,
    message,
    correlationId: ctx.correlationId,
    ...(ctx.phoneNumberId && { phoneNumberId: ctx.phoneNumberId }),
    ...(ctx.operation     && { operation:     ctx.operation }),
    ...extra,
    ts: new Date().toISOString(),
  }
  if (err !== undefined) entry.error = toErrorShape(err)
  console[level](JSON.stringify(entry))
}

export function createLogger(ctx: LogContext): Logger {
  return {
    logInfo:  (message, extra)        => emit('info',  message, ctx, extra),
    logWarn:  (message, extra)        => emit('warn',  message, ctx, extra),
    logError: (message, err, extra)   => emit('error', message, ctx, extra, err),
  }
}
