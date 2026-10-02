import { NextRequest, NextResponse } from 'next/server'
import { query, withTransaction } from '@/lib/db'
import { checkPermissionWithUser } from '@/lib/permissions'
import { getAccessibleLineIds } from '@/lib/line-visibility'
import { getTokenForNumber } from '@/lib/cloud-api/token-store'
import { MetaCloudApiClient } from '@/lib/cloud-api/client'
import { mapMetaStatus } from '@/lib/meta-graph'
import { audit } from '@/lib/audit'
import { buildCatalogueUpsert, detectLegacyTemplateColumns } from '@/lib/template-storage'

// Reads the authenticated user's WABAs from Meta; only updates the local catalogue.
// Does not create/submit a template in Meta and never sends a message.
export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'create')
  if (!auth.ok) return auth.response
  try {
    const ids = await getAccessibleLineIds(auth.user)
    const accounts = await query<{ waba_id:string; phone_number_id:string }>(`SELECT DISTINCT ON (waba_id) waba_id, phone_number_id
      FROM cloud_numbers WHERE status='active' AND ($1::uuid[] IS NULL OR whatsapp_line_id=ANY($1::uuid[]))
      ORDER BY waba_id, token_expires_at DESC NULLS FIRST`, [ids])
    if (!accounts.length) return NextResponse.json({ error:'No hay líneas de WhatsApp API activas accesibles' }, {status:409})
    let synced = 0
    const failed: string[] = []
    for (const account of accounts) {
      try {
        const client = new MetaCloudApiClient(await getTokenForNumber(account.phone_number_id))
        const templates = await client.listTemplates(account.waba_id)
        if (templates.some(t=>!/^\d+$/.test(t.id) || !t.name || !t.language || !Array.isArray(t.components))) throw new Error('invalid_catalogue')
        await withTransaction(async db => {
          // Prevent concurrent syncs from interleaving different snapshots of one WABA.
          await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`templates:${account.waba_id}`])
          const upsert = buildCatalogueUpsert(await detectLegacyTemplateColumns(async (sql, params) => (await db.query(sql, params)).rows))
          for (const t of templates) await db.query(upsert.sql, upsert.values(t, mapMetaStatus(t.status), account.waba_id, auth.user.user_id))
          await db.query(`UPDATE whatsapp_templates SET status='DESHABILITADA',updated_at=NOW()
            WHERE waba_id=$1 AND whatsapp_template_id IS NOT NULL AND NOT (whatsapp_template_id=ANY($2::text[]))`,[account.waba_id,templates.map(t=>t.id)])
        })
        synced += templates.length
      } catch { failed.push(account.waba_id) }
    }
    void audit({req,action:'update',resource:'templates',metadata:{action:'sync_cloud_catalogue',synced,failed_accounts:failed.length}})
    if (failed.length) return NextResponse.json({ error:'No se pudieron sincronizar todas las cuentas; sus plantillas anteriores se conservaron. Revisá la conexión y el token de la línea.',synced,failed_accounts:failed.length },{status:502})
    return NextResponse.json({ok:true,synced,accounts:accounts.length})
  } catch {
    return NextResponse.json({error:'No se pudo actualizar el catálogo de plantillas'}, {status:500})
  }
}
