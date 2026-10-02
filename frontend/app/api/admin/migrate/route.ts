import { NextRequest, NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { isCasinoSyncPaused, casinoSyncPausedResponse } from '@/lib/casino-maintenance'

/** Historical SQL stays in Git. Schema changes now use the verified migration
 * runner, including locking, checksums and explicit special execution modes. */
export async function POST(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err
  if (isCasinoSyncPaused()) return casinoSyncPausedResponse()
  return NextResponse.json({
    error: 'Las migraciones se ejecutan mediante el publicador de versiones verificadas.',
    code: 'USE_VERIFIED_MIGRATION_RUNNER',
  }, {status: 410})
}
