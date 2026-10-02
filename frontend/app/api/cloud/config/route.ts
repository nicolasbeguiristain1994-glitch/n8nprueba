import { NextRequest, NextResponse } from 'next/server'
import { checkPermission } from '@/lib/permissions'
import { cloudConfiguration } from '@/lib/cloud-api/connection'
import { query } from '@/lib/db'
export async function GET(req: NextRequest) {
  const err = await checkPermission(req, 'lines', 'manage')
  if (err) return err
  let database = false
  try {
    await query('SELECT access_token_enc, chatwoot_inbox_id FROM cloud_numbers LIMIT 0')
    await query("SELECT pgp_sym_encrypt('check','configuration-check')")
    for (const table of ['cloud_conversations','cloud_messages','cloud_opt_outs','cloud_stop_keywords','cloud_consent_log','cloud_sync_state']) await query(`SELECT 1 FROM ${table} LIMIT 0`)
    database = true
  } catch { /* report readiness without database internals */ }
  const config = cloudConfiguration()
  return NextResponse.json({ ...config, checks: { ...config.checks, database, redis: !!process.env.REDIS_URL }, webhookPath: '/api/cloud/webhook' }, { headers: { 'Cache-Control': 'no-store' } })
}
