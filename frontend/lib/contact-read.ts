import { query } from '@/lib/db'

export class ContactReadUnavailableError extends Error {
  constructor() { super('La base de datos demoró en responder. Volvé a intentar en unos segundos.') }
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message === 'Query read timeout' ||
    ((error as Error & { code?: string }).code === '57014' && error.message.includes('statement timeout'))
}

/** Retry only idempotent contact SELECTs, once, after a transient DB timeout. */
export async function contactRead<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
  try {
    return await query<T>(sql, params)
  } catch (error) {
    if (!isTimeout(error)) throw error
    console.warn('[contacts] read timeout; retrying SELECT once')
  }
  try {
    return await query<T>(sql, params)
  } catch (error) {
    if (isTimeout(error)) throw new ContactReadUnavailableError()
    throw error
  }
}
