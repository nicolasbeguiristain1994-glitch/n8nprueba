import { NextRequest, NextResponse } from 'next/server'
import { checkPermissionWithUser, isOwnerOrAdmin } from '@/lib/permissions'
import { CampaignRoutingPreviewSchema, parseBody, handleValidationError } from '@/lib/schema'
import { query, withTransaction } from '@/lib/db'
import { resolveCampaignSelection } from '@/lib/campaign-selection-resolver'
import { previewCampaignRouting } from '@/lib/campaign-routing-preview'
import { savedAudienceParams } from '@/lib/dynamic-audiences'
import { resolvedContactFilters } from '@/lib/contact-filters'

export async function POST(req: NextRequest) {
  const auth = await checkPermissionWithUser(req, 'campaigns', 'create')
  if (!auth.ok) return auth.response
  const parsed = parseBody(CampaignRoutingPreviewSchema, await req.json().catch(() => null))
  if (!parsed.ok) return handleValidationError(req, parsed.error, 'campaigns')
  const input = parsed.data, user = auth.user
  if (input.contact_ids) {
    const contacts = await checkPermissionWithUser(req, 'contacts', 'read')
    if (!contacts.ok) return contacts.response
  }
  try {
    const result = await withTransaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const run: typeof query = async (sql, params) => (await client.query(sql, params)).rows
      let waba: string | null = null
      if (input.message_type === 'template') {
        const [template] = await run<{status:string;waba_id:string|null}>(
          `SELECT t.status,t.waba_id FROM whatsapp_templates t WHERE t.id=$1
           AND EXISTS (SELECT 1 FROM cloud_numbers cn WHERE cn.waba_id=t.waba_id AND cn.status='active'
             AND cn.whatsapp_line_id IN (SELECT get_accessible_line_ids($2::uuid)))`, [input.template_id,user.user_id])
        if (!template) throw NextResponse.json({error:'No tenés acceso a esta plantilla o a sus líneas.'},{status:403})
        if (template.status!=='APROBADA' || !template.waba_id) throw NextResponse.json({error:'Seleccioná una plantilla aprobada.'},{status:400})
        waba = template.waba_id
      }
      let phones: string[] = [], selectedCount = 0
      if (input.contact_ids) {
        const {summary,eligibleIds} = await resolveCampaignSelection(input.contact_ids,user,run)
        selectedCount = summary.selected
        phones = (await run<{phone:string}>('SELECT phone_number AS phone FROM contacts WHERE id=ANY($1::uuid[])',[eligibleIds])).map(row=>row.phone)
      } else if (input.list_id) {
        const [list] = await run<{owned_by:string|null;is_dynamic:boolean;filters:unknown}>('SELECT owned_by,is_dynamic,filters FROM contact_lists WHERE id=$1',[input.list_id])
        if (!list) throw NextResponse.json({error:'Lista no encontrada.'},{status:404})
        if (!isOwnerOrAdmin(user,list.owned_by)) throw NextResponse.json({error:'No tenés acceso a esta lista.'},{status:403})
        let membership = 'c.id IN (SELECT contact_id FROM contact_list_members WHERE list_id=$1)', params: unknown[] = [input.list_id]
        if (list.is_dynamic) {
          const filter = await resolvedContactFilters(savedAudienceParams(list.filters),user)
          membership = `c.id IN (SELECT id FROM contacts WHERE ${filter.sql})`; params = filter.params
        }
        const rows = await run<{phone:string;eligible:boolean}>(`SELECT c.phone_number AS phone,
          (c.opt_in_marketing=true AND c.do_not_contact=false AND c.status='active'
           AND NOT EXISTS(SELECT 1 FROM blacklist bl WHERE bl.removed_at IS NULL
             AND bl.phone_number_normalized=regexp_replace(c.phone_number,'[^0-9]','','g')
             AND (bl.scope_key='global' OR bl.agent_code=contact_agent_key(c.panel)))) AS eligible
          FROM contacts c WHERE c.deleted_at IS NULL AND ${membership} LIMIT 100001`, params)
        selectedCount=rows.length; phones=rows.filter(row=>row.eligible).map(row=>row.phone)
      } else {
        const [list] = await run<{owned_by:string|null}>('SELECT owned_by FROM prospect_lists WHERE id=$1',[input.prospect_list_id])
        if (!list) throw NextResponse.json({error:'Lista de difusión no encontrada.'},{status:404})
        if (!isOwnerOrAdmin(user,list.owned_by)) throw NextResponse.json({error:'No tenés acceso a esta lista.'},{status:403})
        const rows = await run<{phone:string;eligible:boolean}>(`SELECT p.phone_number AS phone,
          (p.status='active' AND p.opt_in=true AND p.stage IS DISTINCT FROM 'descartado'
           AND NOT EXISTS(SELECT 1 FROM blacklist bl WHERE bl.removed_at IS NULL AND bl.scope_key='global'
             AND bl.phone_number_normalized=regexp_replace(p.phone_number,'[^0-9]','','g'))) AS eligible
          FROM prospects p JOIN prospect_list_members m ON m.prospect_id=p.id WHERE m.prospect_list_id=$1 LIMIT 100001`,[input.prospect_list_id])
        selectedCount=rows.length; phones=rows.filter(row=>row.eligible).map(row=>row.phone)
      }
      if (selectedCount>100000) throw NextResponse.json({error:'La vista previa admite hasta 100.000 contactos. Acotá la audiencia.'},{status:422})
      const preview = await previewCampaignRouting(phones,user.user_id,waba,run)
      return {...preview,excluded:selectedCount-preview.eligible}
    })
    return NextResponse.json(result,{headers:{'Cache-Control':'private, no-store'}})
  } catch (e) {
    if (e instanceof Response) return e
    console.error('[/api/campaigns/routing-preview]',e instanceof Error ? e.message : e)
    return NextResponse.json({error:'No se pudo calcular el reparto. Reintentá la consulta.'},{status:500})
  }
}
