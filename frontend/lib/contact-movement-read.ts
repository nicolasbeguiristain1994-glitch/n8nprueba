import type { Client } from 'pg'
import { getLongRunningClient } from './db'
import { ContactReadUnavailableError } from './contact-read'

/** Keep history reads bounded and their planner settings local to one request. */
export async function withContactMovementRead<T>(read: (client: Client) => Promise<T>): Promise<T> {
  const client = await getLongRunningClient()
  try {
    await client.query('BEGIN READ ONLY')
    await client.query("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s'; SET LOCAL TIME ZONE 'America/Argentina/Buenos_Aires'; SET LOCAL work_mem='32MB'; SET LOCAL enable_mergejoin=off; SET LOCAL jit=off")
    const result = await read(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    if (error instanceof Error && (error as Error & {code?: string}).code === '57014' && error.message.includes('statement timeout')) {
      throw new ContactReadUnavailableError()
    }
    throw error
  } finally {
    await client.end()
  }
}

/** Broad audiences read the entire ledger. A sequential pass avoids random heap
 * reads; hash joins avoid underestimated username-only JSON links. */
export async function configureBulkMovementRead(client: Client) {
  await client.query("SET LOCAL statement_timeout='45s'; SET LOCAL enable_nestloop=off; SET LOCAL enable_indexscan=off; SET LOCAL enable_indexonlyscan=off")
}
