import { query } from '@/lib/db'
import { checkPermission } from '@/lib/permissions'
import { audit } from '@/lib/audit'
import { AgentDeliverySchema, directoryBody, directoryError, requireAgentCode } from '@/lib/agent-directory'

export async function PATCH(req: Request, {params}: {params: Promise<{code:string}>}) {
  const denied = await checkPermission(req, 'agents', 'manage')
  if (denied) return denied
  try {
    const code = requireAgentCode((await params).code)
    const data = await directoryBody(req, AgentDeliverySchema)
    const rows = await query(`UPDATE crm_agents SET delivery_mode=$2,updated_at=NOW() WHERE code=$1 RETURNING code`, [code,data.delivery_mode])
    if (!rows.length) return Response.json({error:'Agente no encontrado'}, {status:404})
    void audit({req,action:'update',resource:'agents',metadata:{code,delivery_mode:data.delivery_mode}})
    return Response.json({ok:true,delivery_mode:data.delivery_mode})
  } catch(error) { return directoryError(error) }
}
